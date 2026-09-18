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
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: Date.now() + tokens.expires_in * 1e3,
		tokenEndpoint,
		...typeof tokens.scope === "string" ? { scopes: tokens.scope } : {},
		...account === void 0 ? {} : { account }
	};
}
/**
* Exchange an authorization code for a grok session (form-encoded grant that
* echoes the PKCE challenge as well as the verifier, per the xAI flow).
* A 403 here means the X plan lacks the API OAuth entitlement.
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @param challenge - the PKCE challenge sent at authorize time.
* @returns the session to store.
*/
async function exchangeGrokCode(code, verifier, redirectUri, challenge) {
	const discovery = await grokDiscovery();
	const response = await fetch(discovery.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: GROK_CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			code_challenge: challenge,
			code_challenge_method: "S256"
		}).toString()
	});
	if (response.status === 403) throw new OAuthEndpointError("grok token endpoint refused the exchange (HTTP 403): your X plan does not include the API OAuth entitlement; an X Premium or xAI subscription with API access is required", 403);
	if (!response.ok) throw await oauthEndpointError(response, "grok");
	return grokSession(await response.json(), discovery.tokenEndpoint);
}
/**
* Refresh a grok session (form-encoded grant).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshGrok(session) {
	const response = await fetch(session.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: GROK_CLIENT_ID,
			refresh_token: session.refreshToken
		}).toString()
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok");
	const next = grokSession(await response.json(), session.tokenEndpoint, session.refreshToken);
	return {
		...next,
		...session.account === void 0 ? {} : { account: session.account },
		...next.scopes === void 0 && session.scopes !== void 0 ? { scopes: session.scopes } : {}
	};
}
/**
* Whether a grok refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isGrokPermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && error.oauthCode === "invalid_grant";
}
/**
* The Grok Build CLI chat proxy's billing endpoint (the source of the CLI's
* `/usage` "Usage limit" panel; see xai-org/grok-build
* `extensions/billing.rs`). Forwards to the backend `GetGrokCreditsConfig`.
*/
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** RFC3339 timestamp â†’ epoch ms, or undefined when absent/unparsable. */
function grokResetsAt(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Fetch the grok subscription usage from the Grok Build CLI chat proxy. The
* newer credits config carries a ready-made percentage plus the current
* (typically weekly) period; the legacy shape carries cent-valued
* `monthlyLimit`/`used`, from which the percentage is derived.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchGrokUsage(session, fetchFn = fetch, signal) {
	const response = await fetchFn(GROK_BILLING_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"x-xai-token-auth": "xai-grok-cli",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok billing");
	const payload = await response.json();
	const config = typeof payload.config === "object" && payload.config !== null ? payload.config : {};
	const windows = [];
	if (typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent)) {
		const kind = config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : "other";
		const resetsAt = grokResetsAt(config.currentPeriod?.end);
		windows.push({
			kind,
			usedPercent: config.creditUsagePercent,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	} else if (typeof config.monthlyLimit?.val === "number" && config.monthlyLimit.val > 0) {
		const used = typeof config.used?.val === "number" ? config.used.val : 0;
		const resetsAt = grokResetsAt(config.billingPeriodEnd);
		windows.push({
			kind: "other",
			usedPercent: used / config.monthlyLimit.val * 100,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	}
	const plan = typeof payload.subscriptionTier === "string" && payload.subscriptionTier.length > 0 ? payload.subscriptionTier : grokTierName(session.accessToken);
	return {
		supported: true,
		windows,
		...plan === void 0 ? {} : { plan }
	};
}
