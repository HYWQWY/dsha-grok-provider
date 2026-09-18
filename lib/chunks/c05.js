	if (raw.maxTokens !== void 0 && (typeof raw.maxTokens !== "number" || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)) return void 0;
	if (raw.inputModalities !== void 0 && (!Array.isArray(raw.inputModalities) || raw.inputModalities.length === 0 || raw.inputModalities.some((modality) => modality !== "text" && modality !== "image"))) return void 0;
	const reasoning = raw.reasoning === void 0 ? void 0 : sanitizeReasoning(raw.reasoning);
	if (raw.reasoning !== void 0 && reasoning === void 0) return void 0;
	const thinkingType = raw.thinkingType;
	if (thinkingType !== void 0 && thinkingType !== "enabled" && thinkingType !== "adaptive") return void 0;
	const fastTier = raw.fastTier;
	if (fastTier !== void 0 && typeof fastTier !== "boolean") return void 0;
	return {
		id: raw.id,
		name: raw.name,
		...raw.description === void 0 ? {} : { description: raw.description },
		...raw.contextWindow === void 0 ? {} : { contextWindow: raw.contextWindow },
		...raw.priority === void 0 ? {} : { priority: raw.priority },
		...raw.apiId === void 0 ? {} : { apiId: raw.apiId },
		...raw.maxTokens === void 0 ? {} : { maxTokens: raw.maxTokens },
		...raw.inputModalities === void 0 ? {} : { inputModalities: [...raw.inputModalities] },
		...reasoning === void 0 ? {} : { reasoning },
		...thinkingType === void 0 ? {} : { thinkingType },
		...fastTier === void 0 ? {} : { fastTier }
	};
}
/**
* Validate one persisted snapshot. Strict: any malformed field drops the
* whole snapshot rather than repairing it â€” the next successful discovery
* rewrites the entry anyway.
* @param value - the raw per-provider file entry.
* @returns the validated snapshot, or undefined when unusable.
*/
function sanitizeSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return void 0;
	if (!Array.isArray(raw.models) || raw.models.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const entry of raw.models) {
		const model = sanitizeModel(entry);
		if (model === void 0 || seen.has(model.id)) return void 0;
		seen.add(model.id);
		models.push(model);
	}
	return {
		at: raw.at,
		models
	};
}
/** Read the whole file; missing or unparsable reads as an empty cache. */
async function readCatalogFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/** Persist the whole file atomically (tmp file + rename). */
async function writeCatalogFile(store, path) {
	await mkdir(dirname(path), { recursive: true, mode: 448 });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2));
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Build the durable half of one provider's catalog cache over the shared
* models.json file (concurrent writers are last-writer-wins, acceptable for
* a cache).
* @param provider - the provider route keying the file entry.
* @param path - store file path; defaults to {@link modelsFilePath}.
* @returns the persistence hooks for {@link ModelCatalogCache}.
*/
function catalogStore(provider, path = modelsFilePath()) {
	return {
		async load() {
			return sanitizeSnapshot((await readCatalogFile(path))[provider]);
		},
		async save(snapshot) {
			const store = await readCatalogFile(path);
			store[provider] = snapshot;
			await writeCatalogFile(store, path);
		},
		async clear() {
			const store = await readCatalogFile(path);
			if (store[provider] === void 0) return;
			delete store[provider];
			await writeCatalogFile(store, path);
		}
	};
}

//#endregion

//#region src/auth/jwt.ts
/** Minimal JWT payload decoding for claims extraction (no signature verification). */
/**
* Decode a JWT payload without verifying the signature. Used only to read
* account claims from `id_token`s issued over the provider's own TLS channel
* during a code exchange we initiated â€” never to authorize anything.
* @param token - the compact JWT string.
* @returns the parsed payload object, or `undefined` when the token is not a
*   well-formed JWT with a JSON object payload.
*/
function decodeJwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	return parsed;
}

//#endregion

//#region src/translate/resolved.ts
/**
* Resolve every ImageBlock's attachment reference to inline base64 bytes.
* Messages without images pass through unchanged. A request carrying an image
* with no attachment service available fails loudly rather than silently
* dropping the image.
* @param messages - the request's conversation messages.
* @param attachments - the deployment's attachment service, when mounted.
* @param signal - cancellation for the storage reads.
* @returns the same messages with image blocks resolved for the translators.
*/
async function resolveImages(messages, attachments, signal) {
	if (!messages.some((message) => message.content.some((block) => block.type === "image"))) return messages;
	if (attachments === void 0) throw new LlmError("dsha-grok-provider: the request carries an image but no attachments service is mounted; image input requires the harness attachment store", "UNSUPPORTED");
	return Promise.all(messages.map(async (message) => ({
		role: message.role,
		content: await Promise.all(message.content.map(async (block) => {
			if (block.type !== "image") return block;
			const stored = await attachments.readImage(block.attachment, signal);
			return {
				type: "image",
				mediaType: stored.ref.mediaType,
				dataBase64: Buffer.from(stored.data).toString("base64")
			};
		}))
	})));
}

//#endregion

//#region src/translate/sse.ts
/**
* Decode an SSE byte stream into events.
* @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onActivity - called on every received chunk and comment line; drives the idle watchdog.
* @returns events in arrival order.
*/
async function* parseSse(stream, onActivity) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let dataLines = [];
	let eventName;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			onActivity?.();
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				let line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length === 0) {
					if (dataLines.length > 0) yield {
						data: dataLines.join("\n"),
						...eventName === void 0 ? {} : { event: eventName }
					};
					dataLines = [];
					eventName = void 0;
				} else if (line.startsWith(":")) onActivity?.();
				else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
				else if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

//#endregion

//#region src/translate/responses.ts
/** Flatten a tool result's content to plain text for `function_call_output`. */
function toolResultText$1(block) {
	return block.content.map((part) => part.type === "text" ? part.text : "").join("");
}
/**
* Convert harness messages into Responses `instructions` + `input` items.
* System-role messages become `instructions`; an explicit `system` argument
* wins over them when both exist. Reasoning blocks are not replayed (v1).
* Images must arrive pre-resolved ({@link TranslatableMessage}); an unresolved
* ImageBlock is skipped because its bytes are unreachable here.
* @param messages - ordered conversation messages with resolved images.
* @param system - explicit system prompt, which takes precedence.
* @returns request fields ready to merge into the request body.
*/
/** Codex rejects function_call.call_id longer than 64 characters. */
function codexCallId(id) {
	const raw = String(id ?? "");
	if (raw.length > 0 && raw.length <= 64) return raw;
	return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}
function toResponsesInput(messages, system) {
	const input = [];
	const systemTexts = [];
	for (const message of messages) {
		if (message.role === "system") {
			for (const block of message.content) if (block.type === "text") systemTexts.push(block.text);
			continue;
		}
		const role = message.role;
		let content = [];
		const flushMessage = () => {
			if (content.length === 0) return;
			input.push({
				type: "message",
				role,
				content
			});
			content = [];
		};
		for (const block of message.content) switch (block.type) {
			default: break;
		}
		flushMessage();
	}
	const instructions = system ?? (systemTexts.length > 0 ? systemTexts.join("\n\n") : void 0);
	return {
		...instructions === void 0 ? {} : { instructions },
		input: pairResponsesToolCalls(input)
	};
}
/** Codex rejects a function_call with no matching function_call_output. Interrupted
 *  subagents and compacted history can leave orphans; synthesize a short result. */
function pairResponsesToolCalls(input) {
	const outputById = new Map();
	for (const item of input) {
		if (item?.type === "function_call_output" && typeof item.call_id === "string" && item.call_id.length > 0 && !outputById.has(item.call_id)) outputById.set(item.call_id, item);
	}
	const paired = [];
	const usedOutputs = new Set();
	for (const item of input) {
		if (item?.type === "function_call" && typeof item.call_id === "string" && item.call_id.length > 0) {
			paired.push(item);
			if (!usedOutputs.has(item.call_id)) {
				paired.push(outputById.get(item.call_id) ?? { type: "function_call_output", call_id: item.call_id, output: "[tool interrupted before a result was returned]" });
				usedOutputs.add(item.call_id);
			}
			continue;
		}
		if (item?.type === "function_call_output") continue;
		paired.push(item);
	}
	return paired;
}
/**
