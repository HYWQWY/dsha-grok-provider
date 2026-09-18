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
/** RFC3339 timestamp → epoch ms, or undefined when absent/unparsable. */
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
const GROK_MODELS_URL = "https://api.x.ai/v1/models";
/**
* Input modalities for one grok model: chat models (grok-4 family) accept
* images; code and embedding models are text-only.
*/
function grokModalities(id) {
	return /code|embed/i.test(id) ? ["text"] : ["text", "image"];
}
/**
* The Grok Build CLI chat proxy's model catalog — the only grok endpoint that
* advertises reasoning capability. The `api.x.ai/v1/models` and
* `/v1/language-models` payloads carry pricing, context, and aliases only, so
* effort metadata must come from here (the same source the official CLI's
* picker uses).
*/
const GROK_CLI_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
/** Map one CLI catalog entry's reasoning fields, or undefined when unsupported. */
function grokCliReasoning(entry) {
	if (entry.supports_reasoning_effort !== true) return void 0;
	const efforts = (entry.reasoning_efforts ?? []).filter((level) => typeof level.value === "string" && level.value.length > 0).map((level) => ({
		id: ReasoningEffortId(level.value),
		name: typeof level.label === "string" && level.label.length > 0 ? level.label : level.value,
		...typeof level.description === "string" && level.description.length > 0 ? { description: level.description } : {}
	}));
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof entry.reasoning_effort === "string" && efforts.some((effort) => effort.id === ReasoningEffortId(entry.reasoning_effort)) ? ReasoningEffortId(entry.reasoning_effort) : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
/**
* Fetch the CLI catalog and index its per-model metadata by model id.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @returns model id → contributed metadata.
*/
async function fetchGrokCliCatalog(session, fetchFn = fetch) {
	const response = await fetchFn(GROK_CLI_MODELS_URL, { headers: {
		"authorization": `Bearer ${session.accessToken}`,
		"x-xai-token-auth": "xai-grok-cli",
		"accept": "application/json",
		...attributionHeaders()
	} });
	if (!response.ok) throw await oauthEndpointError(response, "grok CLI catalog");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("grok CLI catalog returned no data array");
	const catalog = /* @__PURE__ */ new Map();
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0) continue;
		const reasoning = grokCliReasoning(entry);
		catalog.set(entry.id, {
			...typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {},
			...typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {},
			...typeof entry.context_window === "number" && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	return catalog;
}
/**
* The /v1/models list also serves generation models that cannot chat
* (grok-imagine-image*, grok-imagine-video*) and embedding models; the picker
* must not offer them. Heuristic over the id substring, verified against the
* live catalog (grok-build-0.1 and the grok-4 family pass).
*/
function isChatModel(id) {
	return !/imagine|image-|video|embed/i.test(id);
}
/**
* Fetch the live grok model list, enriched with the CLI catalog's per-model
* metadata (display name, context window, reasoning efforts). The api.x.ai
* list stays authoritative for which models exist; the CLI catalog is
* enrichment only, so its failure degrades to a plain list instead of taking
* discovery down — models it does not cover simply expose no efforts.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param onWarn - warning sink for a failed CLI catalog fetch.
* @returns discovered chat models in endpoint order.
*/
async function fetchGrokModels(session, fetchFn = fetch, onWarn) {
	const [response, cliCatalog] = await Promise.all([fetchFn(GROK_MODELS_URL, { headers: {
		"authorization": `Bearer ${session.accessToken}`,
		"accept": "application/json",
		...attributionHeaders()
	} }), fetchGrokCliCatalog(session, fetchFn).catch((error) => {
		onWarn?.(`grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})`);
	})]);
	if (!response.ok) throw await oauthEndpointError(response, "grok models");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("grok models endpoint returned no data array");
	const seen = /* @__PURE__ */ new Set();
	const discovered = [];
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0 || seen.has(entry.id)) continue;
		if (!isChatModel(entry.id)) continue;
		seen.add(entry.id);
		discovered.push({
			id: entry.id,
			name: entry.id,
			...cliCatalog?.get(entry.id)
		});
	}
	if (discovered.length === 0) throw new Error("grok models endpoint returned an empty catalog");
	return discovered;
}
