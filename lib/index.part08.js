const GROK_MODELS_URL = "https://api.x.ai/v1/models";
/**
* Input modalities for one grok model: chat models (grok-4 family) accept
* images; code and embedding models are text-only.
*/
function grokModalities(id) {
	return /code|embed/i.test(id) ? ["text"] : ["text", "image"];
}
/**
* The Grok Build CLI chat proxy's model catalog â€” the only grok endpoint that
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
* @returns model id â†’ contributed metadata.
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
* discovery down â€” models it does not cover simply expose no efforts.
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
/** Grok wire adapter: one instance serves the `grok` provider route. */
var GrokAdapter = class extends LlmAdapter {
	catalog;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	/** Discovery fetcher: resolves the session through the refresh-aware path. */
	async fetchCatalog() {
		return fetchGrokModels(await this.options.tokens.session(), this.options.fetchFn, this.options.onWarn);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Grok (Subscription)"
		};
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? grokModalities(model.id)
		}));
	}
	async listModels(provider) {
		if (await this.options.tokens.peek() === void 0) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		try {
			return (await this.catalog.get(() => this.fetchCatalog())).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				inputModalities: grokModalities(model.id)
			}));
		} catch (error) {
			if (error instanceof LlmError && (error.code === "MISSING_CREDENTIAL" || error.code === "INVALID_CREDENTIAL")) return [];
			if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate();
			this.options.onWarn?.(`grok model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	/**
	* The discovered entry for one model. Resolved through the cache's
	* stale-while-revalidate path: capability metadata must stay stable across
	* a long conversation â€” a session that selected a reasoning effort calls
	* this on EVERY step, and forgetting the efforts just because the TTL
	* lapsed mid-turn would fail the call with UNSUPPORTED_REASONING_EFFORT
	* before provider I/O.
	*/
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return (await this.catalog.resolve(() => this.fetchCatalog()))?.find((entry) => entry.id === model);
	}
	async resolveModel(provider, model) {
		const discovered = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: configured?.inputModalities ?? grokModalities(model),
			context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
			...discovered?.reasoning === void 0 ? {} : { reasoning: discovered.reasoning }
		};
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session();
			let response;
			try {
				response = await this.request(options, session, watchdog.signal);
			} catch (first) {
				if (!isDeadProxyError(first)) throw first;
				response = await this.requestDirect(options, session, watchdog.signal);
			}
			if (response.status === 413) {
				response = await this.request(options, session, watchdog.signal, "aggressive");
				if (response.status === 413) response = await this.request(options, session, watchdog.signal, "minimal");
			}
			if (response.status === 401) {
				session = await this.options.tokens.session(true);
				response = await this.request(options, session, watchdog.signal);
				if (response.status === 413) {
					response = await this.request(options, session, watchdog.signal, "aggressive");
					if (response.status === 413) response = await this.request(options, session, watchdog.signal, "minimal");
				}
			}
			if (!response.ok) throw await httpLlmError(response, "grok API");
			if (response.body === null) throw new LlmError("grok API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamResponses(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("grok API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	async requestDirect(options, session, signal, compactLevel) {
		return this.requestWithFetch(options, session, signal, compactLevel, fetchDirect);
	}
	async request(options, session, signal, compactLevel) {
		return this.requestWithFetch(options, session, signal, compactLevel, fetch);
	}
	async requestWithFetch(options, session, signal, compactLevel, fetchFn) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const body = buildGrokBody(options, messages, compactLevel);
		return fetchFn(GROK_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"accept": "text/event-stream",
				"content-type": "application/json",
				...attributionHeaders()
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion

//#region src/tools/x-search.ts
/** Endpoint the search request is posted to. */
const X_SEARCH_URL = "https://api.x.ai/v1/responses";
/** Grok model the search runs on (a catalog model of the grok provider). */
const X_SEARCH_MODEL = "grok-4";
/** xAI caps each handle filter list at ten entries. */
const MAX_HANDLES = 10;
/**
* Validate and assemble the request facts from tool arguments. Throws plain
* Errors for argument problems the schema DSL cannot express (non-empty
* query, handle caps, mutually exclusive filters).
*/
function buildXSearchRequest(args) {
	const query = args.query.trim();
	if (query.length === 0) throw new Error("x_search: query must be a non-empty string");
