		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
* Classify a Responses failure payload into a thrown LlmError.
* @param code - provider error code, when present.
* @param message - provider error message, when present.
* @returns the mapped error (context overflow, quota, otherwise SERVER).
*/
function responsesFailure(code, message) {
	const text = message ?? code ?? "the provider reported a failed response";
	const detail = `${code ?? ""} ${message ?? ""}`;
	if (code === "context_window_exceeded" || isContextWindowExceededError(detail)) return new LlmError(text, CONTEXT_WINDOW_EXCEEDED_CODE);
	if (code !== void 0 && /insufficient|quota/i.test(code) || isQuotaExceededError(detail)) return new LlmError(text, QUOTA_EXCEEDED_CODE);
	return new LlmError(text, "SERVER");
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock$1(block) {
	switch (block.kind) {
		case "text":
			return {
				type: "text",
				text: block.text
			};
		case "reasoning":
			return {
				type: "reasoning",
				text: block.text
			};
		case "tool-call":
			return {
				type: "tool-call",
				id: ToolCallId(block.callId),
				name: block.name ?? "",
				arguments: block.text
			};
	}
}
/**
* Push-model Responses SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes are
* allocated in first-seen order; `usage` is emitted before the terminal
* `finish`, and nothing is emitted after it. Terminal provider failures
* throw {@link LlmError}.
*/
var ResponsesStreamTranslator = class {
	blocks = /* @__PURE__ */ new Map();
	order = [];
	nextIndex = 0;
	sawToolCall = false;
	/** Set once `response.completed` produced the terminal finish chunk. */
	terminated = false;
	open(key, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(key, block);
		this.order.push(block);
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	textBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "text", chunks);
	}
	reasoningBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "reasoning", chunks);
	}
	close(key, chunks) {
		const block = this.blocks.get(key);
		if (block === void 0) return;
		this.blocks.delete(key);
		chunks.push({
			type: "block-end",
			index: block.index,
			block: closeBlock$1(block)
		});
	}
	/** Close every still-open block for one output item (prefix match on the key). */
	closeItem(itemId, chunks) {
		for (const key of [...this.blocks.keys()]) if (key.startsWith(`${itemId}:`)) this.close(key, chunks);
	}
	/** Close every still-open block (provider ended the response without done events). */
	closeAll(chunks) {
		for (const block of this.order) this.closeKeyIfOpen(block, chunks);
	}
	closeKeyIfOpen(block, chunks) {
		for (const [key, candidate] of this.blocks) if (candidate === block) {
			this.blocks.delete(key);
			chunks.push({
				type: "block-end",
				index: block.index,
				block: closeBlock$1(block)
			});
			return;
		}
	}
	/**
	* Process one parsed Responses SSE event.
	* @param event - the parsed event object.
	* @returns the StreamChunks this event produced (possibly none).
	*/
	push(event) {
		if (this.terminated) return [];
		const chunks = [];
		switch (event.type) {
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type === "function_call" && item.id !== void 0) {
					this.sawToolCall = true;
					const callId = item.call_id ?? "";
					const block = this.open(`${item.id}:call`, "tool-call", chunks, callId, item.name);
					chunks.push({
						type: "tool-call-delta",
						index: block.index,
						id: ToolCallId(callId),
						...item.name === void 0 ? {} : { name: item.name },
						argumentsDelta: ""
					});
				}
				return chunks;
			}
			case "response.output_text.delta": {
				const key = `${event.item_id ?? ""}:text:${String(event.content_index ?? 0)}`;
				const block = this.textBlock(key, chunks);
				block.text += event.delta ?? "";
				chunks.push({
					type: "text-delta",
					index: block.index,
					text: event.delta ?? ""
				});
				return chunks;
			}
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta": {
				const sub = event.summary_index ?? event.content_index ?? 0;
				const key = `${event.item_id ?? ""}:reason:${String(sub)}`;
				const block = this.reasoningBlock(key, chunks);
				block.text += event.delta ?? "";
				chunks.push({
					type: "reasoning-delta",
					index: block.index,
					text: event.delta ?? ""
				});
				return chunks;
			}
			case "response.function_call_arguments.delta": {
				const key = `${event.item_id ?? ""}:call`;
				let block = this.blocks.get(key);
				if (block === void 0) {
					this.sawToolCall = true;
					block = this.open(key, "tool-call", chunks);
				}
				block.text += event.delta ?? "";
				chunks.push({
					type: "tool-call-delta",
					index: block.index,
					id: ToolCallId(block.callId),
					...block.name === void 0 ? {} : { name: block.name },
					argumentsDelta: event.delta ?? ""
				});
				return chunks;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item === void 0 || item.id === void 0) return chunks;
				if (item.type === "function_call") {
					const key = `${item.id}:call`;
					const block = this.blocks.get(key);
					if (block !== void 0 && block.text.length === 0 && item.arguments !== void 0) block.text = item.arguments;
					this.close(key, chunks);
				} else if (item.type === "message") {
					if (![...this.blocks.keys()].some((key) => key.startsWith(`${item.id}:text:`))) {
						for (const [partIndex, part] of (item.content ?? []).entries()) {
							if (part?.type !== "output_text" || typeof part.text !== "string" || part.text.length === 0) continue;
							const block = this.open(`${item.id}:text:${partIndex}`, "text", chunks);
							block.text = part.text;
							this.close(`${item.id}:text:${partIndex}`, chunks);
						}
					}
					this.closeItem(item.id, chunks);
				} else this.closeItem(item.id, chunks);
				return chunks;
			}
			case "response.completed": {
				this.terminated = true;
				this.closeAll(chunks);
				const usage = event.response?.usage;
				if (usage !== void 0) chunks.push({
					type: "usage",
					usage: mapResponsesUsage(usage)
				});
				if (this.order.length === 0) chunks.push({
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "model returned a completed response with no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				});
				else chunks.push({
					type: "finish",
					reason: { kind: this.sawToolCall ? "tool-calls" : "stop" }
				});
				return chunks;
			}
			case "response.failed":
				throw responsesFailure(event.response?.error?.code, event.response?.error?.message);
			case "response.incomplete":
				throw responsesFailure(event.response?.incomplete_details?.reason, event.response?.error?.message ?? `the provider reported an incomplete response (${event.response?.incomplete_details?.reason ?? "unknown reason"})`);
			case "error":
				throw responsesFailure(event.code, event.message);
			default:
				return chunks;
		}
	}
};
/**
* Consume a Responses SSE byte stream and yield harness StreamChunks.
* @param stream - raw response body.
* @param onActivity - transport-activity callback for the idle watchdog.
* @returns the chunk stream; throws when the stream ends before `response.completed`.
*/
async function* streamResponses(stream, onActivity) {
	const translator = new ResponsesStreamTranslator();
	for await (const sseEvent of parseSse(stream, onActivity)) {
		let event;
		try {
			event = JSON.parse(sseEvent.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		yield* translator.push(event);
		if (translator.terminated) return;
	}
	throw new LlmError("Responses SSE stream ended before response.completed", "STREAM_CLOSED");
}

//#endregion

//#region src/providers/grok.ts
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const GROK_API_URL = "https://api.x.ai/v1/responses";
const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const GROK_CALLBACK_PATH = "/callback";
const GROK_CONTEXT_WINDOW = 5e5;
const GROK_DEFAULT_MAX_TOKENS = 32e3;
/** Refresh when the access token has less than this much life left. */
const GROK_PREEMPT_MS = 2 * 6e4;
/** A discovered URL must be https on x.ai or a subdomain; anything else is a hostile document. */
function assertXaiEndpoint(url, field) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`grok OIDC discovery returned an invalid ${field}`);
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "x.ai" && !parsed.hostname.endsWith(".x.ai")) throw new Error(`grok OIDC discovery returned a non-x.ai ${field}: ${url}`);
	return url;
}
let discoveryCache;
/**
* Resolve the xAI OIDC endpoints (cached after the first fetch).
* @returns validated authorization and token endpoints.
*/
async function grokDiscovery() {
	if (discoveryCache !== void 0) return discoveryCache;
	const response = await fetch(GROK_DISCOVERY_URL);
	if (!response.ok) throw await oauthEndpointError(response, "grok OIDC discovery");
	const document = await response.json();
	if (typeof document.authorization_endpoint !== "string" || typeof document.token_endpoint !== "string") throw new Error("grok OIDC discovery document is missing endpoints");
	discoveryCache = {
		authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, "authorization_endpoint"),
		tokenEndpoint: assertXaiEndpoint(document.token_endpoint, "token_endpoint")
	};
	return discoveryCache;
}
/**
* Build the grok flow facts for the OAuth flow engine (async because the
* authorize URL comes from OIDC discovery).
* @returns the flow spec for one attempt.
*/
async function grokFlow() {
	const discovery = await grokDiscovery();
	return {
		callbackPath: GROK_CALLBACK_PATH,
		listen: {
			host: "127.0.0.1",
			ports: [56121]
		},
		buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
			const params = new URLSearchParams({
				response_type: "code",
				client_id: GROK_CLIENT_ID,
				redirect_uri: redirectUri,
				scope: GROK_SCOPE,
				code_challenge: pkce.challenge,
				code_challenge_method: "S256",
				state,
				nonce,
				plan: "generic",
				referrer: "dsha-grok-provider"
			});
			return `${discovery.authorizationEndpoint}?${params.toString()}`;
		}
	};
}
/**
* Display names for the numeric `tier` claim xAI stamps on OAuth access
* tokens (the `prod_auth.SubscriptionTier` proto enum; the mapping mirrors
* grok-build's `jwt_tier_claim`). Unknown values fall through to the raw
* number so a future tier still shows something.
*/
const GROK_TIER_NAMES = {
	0: "Free",
	1: "SuperGrok",
	2: "X Basic",
	3: "X Premium",
	4: "X Premium+",
	5: "SuperGrok Heavy",
	6: "SuperGrok Lite",
	7: "SuperGrok Plus"
};
/**
* The subscription tier encoded in a grok access token's `tier` claim (no
* verification â€” same trust posture as the other claim reads).
* @param accessToken - the stored access token.
* @returns the display tier name, or undefined when the claim is absent.
*/
function grokTierName(accessToken) {
	const tier = decodeJwtPayload(accessToken)?.tier;
	if (typeof tier !== "number" || !Number.isInteger(tier)) return void 0;
	return GROK_TIER_NAMES[tier] ?? String(tier);
}
/** Pick a display account from an id token's claims. */
function grokAccount(idToken) {
	const payload = idToken === void 0 ? void 0 : decodeJwtPayload(idToken);
	const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub;
	return typeof claim === "string" && claim.length > 0 ? claim : void 0;
}
/** Build a session from a token response. */
function grokSession(tokens, tokenEndpoint, fallbackRefreshToken) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("grok token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
	if (refreshToken === void 0) throw new Error("grok token endpoint returned no refresh token");
	if (typeof tokens.expires_in !== "number" || tokens.expires_in <= 0) throw new Error("grok token endpoint returned no usable expiry");
	const account = grokAccount(tokens.id_token);
	return {
