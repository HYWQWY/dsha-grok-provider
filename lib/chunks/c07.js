		input = compactGrokInput(input, minimal ? GROK_MINIMAL_FINAL_INPUT_BUDGET : GROK_FINAL_INPUT_BUDGET, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (compactLevel !== void 0 && utf8Bytes(body) > GROK_RETRY_BODY_LIMIT) {
		// A 413 retry must be comfortably below xAI's limit even when the
		// original failure came mostly from tool schemas rather than history.
		instructions = shortenGrokText(instructions, 8_000);
		input = compactGrokInput(input, GROK_MINIMAL_FINAL_INPUT_BUDGET, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (compactLevel !== void 0 && utf8Bytes(body) > GROK_RETRY_BODY_LIMIT) {
		// Tool definitions are optional for this last-resort replay. Dropping
		// them is safer than sending another request that the provider rejects.
		instructions = shortenGrokText(instructions, 4_000);
		input = compactGrokInput(input, 24_000, "minimal");
		tools = void 0;
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (utf8Bytes(body) > GROK_BODY_HARD_LIMIT) {
		instructions = shortenGrokText(instructions, 4_000);
		input = compactGrokInput(input, 24_000, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	return body;
}
/**
* Map Responses usage to disjoint harness counts (cached input is subtracted
* out of `inputTokens` and reported as `cacheReadTokens`).
* @param usage - wire usage from `response.completed`.
* @returns harness token usage.
*/
function mapResponsesUsage(usage) {
	const cached = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.input_tokens - (cached ?? 0),
		outputTokens: usage.output_tokens,
		...cached !== void 0 ? { cacheReadTokens: cached } : {},
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
}
}
/**
* Push-model Responses SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes
* are allocated in first-seen order; `usage` is emitted before the terminal
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
			default: return chunks;
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
