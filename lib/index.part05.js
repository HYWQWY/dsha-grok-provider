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
* Map harness tool schemas to Responses function tools.
* @param tools - tool schemas from the request.
* @returns Responses `tools` array entries.
*/
function toResponsesTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/** Grok rejects oversized Responses payloads with HTTP 413. Keep the
 * newest human turns, preserve function-call/output pairs, and bound large
 * tool results before retrying instead of failing the whole agent turn. */
const GROK_BODY_SOFT_LIMIT = 900_000;
const GROK_BODY_HARD_LIMIT = 1_200_000;
const GROK_RETRY_BODY_LIMIT = 400_000;
const GROK_INPUT_BUDGET = 650_000;
const GROK_AGGRESSIVE_INPUT_BUDGET = 300_000;
const GROK_FINAL_INPUT_BUDGET = 180_000;
const GROK_MINIMAL_INPUT_BUDGET = 96_000;
const GROK_MINIMAL_FINAL_INPUT_BUDGET = 48_000;
const GROK_MAX_TOOL_OUTPUT_CHARS = 16_000;
const GROK_AGGRESSIVE_TOOL_OUTPUT_CHARS = 6_000;
const GROK_MINIMAL_TOOL_OUTPUT_CHARS = 2_000;
const GROK_MAX_ARGUMENT_CHARS = 24_000;
const GROK_AGGRESSIVE_ARGUMENT_CHARS = 8_000;
const GROK_MINIMAL_ARGUMENT_CHARS = 4_000;
const GROK_MAX_MESSAGE_TEXT_CHARS = 64_000;
const GROK_AGGRESSIVE_MESSAGE_TEXT_CHARS = 32_000;
const GROK_MINIMAL_MESSAGE_TEXT_CHARS = 12_000;
const GROK_MAX_INSTRUCTIONS_CHARS = 96_000;
const GROK_AGGRESSIVE_INSTRUCTIONS_CHARS = 48_000;
const GROK_MINIMAL_INSTRUCTIONS_CHARS = 16_000;
const GROK_MAX_IMAGE_CHARS = 320_000;

function utf8Bytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function shortenGrokText(value, maximum, keepTail = false) {
	if (typeof value !== "string" || value.length <= maximum) return value;
	if (maximum <= 0) return "";
	const marker = "\n…[older content omitted to fit Grok request]…\n";
	const room = Math.max(0, maximum - marker.length);
	if (keepTail) {
		const head = Math.min(Math.floor(room * 0.2), 2000);
		return value.slice(0, head) + marker + value.slice(-(room - head));
	}
	const head = Math.floor(room * 0.7);
	return value.slice(0, head) + marker + value.slice(-Math.max(0, room - head));
}
/** Keep a function-call argument syntactically valid when shortening history. */
function compactGrokArguments(value, maximum) {
	if (typeof value !== "string" || value.length <= maximum) return value;
	try {
		const normalized = JSON.stringify(JSON.parse(value));
		if (normalized.length <= maximum) return normalized;
	} catch {}
	return "{\"_dsh_history_truncated\":true}";
}
function compactGrokInputItem(item, level) {
	const aggressive = level === true || level === "aggressive" || level === "minimal";
	const minimal = level === "minimal";
	if (item?.type === "function_call_output") return {
		...item,
		output: shortenGrokText(item.output, minimal ? GROK_MINIMAL_TOOL_OUTPUT_CHARS : aggressive ? GROK_AGGRESSIVE_TOOL_OUTPUT_CHARS : GROK_MAX_TOOL_OUTPUT_CHARS, true)
	};
	if (item?.type === "function_call") return {
		...item,
		arguments: compactGrokArguments(item.arguments, minimal ? GROK_MINIMAL_ARGUMENT_CHARS : aggressive ? GROK_AGGRESSIVE_ARGUMENT_CHARS : GROK_MAX_ARGUMENT_CHARS)
	};
	if (item?.type !== "message" || !Array.isArray(item.content)) return item;
	const maximum = minimal ? GROK_MINIMAL_MESSAGE_TEXT_CHARS : aggressive ? GROK_AGGRESSIVE_MESSAGE_TEXT_CHARS : GROK_MAX_MESSAGE_TEXT_CHARS;
	let textBudget = minimal ? 16_000 : aggressive ? 48_000 : 96_000;
	const content = [];
	for (const part of item.content) {
		if (part?.type === "input_text" || part?.type === "output_text") {
			const limit = Math.min(maximum, textBudget);
			if (limit > 0) content.push({ ...part, text: shortenGrokText(part.text, limit) });
			textBudget -= Math.min(typeof part.text === "string" ? part.text.length : 0, limit);
			continue;
		}
		if (part?.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:") && (minimal || aggressive || part.image_url.length > GROK_MAX_IMAGE_CHARS)) {
			content.push({ type: "input_text", text: "[image omitted from Grok history to fit request limit]" });
			continue;
		}
		content.push(part);
	}
	return { ...item, content };
}
function grokUserTurnStarts(input) {
	const starts = [];
