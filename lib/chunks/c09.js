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
	* a long conversation — a session that selected a reasoning effort calls
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
	const allowed = normalizeHandles(args.allowed_x_handles, "allowed_x_handles");
	const excluded = normalizeHandles(args.excluded_x_handles, "excluded_x_handles");
	if (allowed.length > 0 && excluded.length > 0) throw new Error("x_search: allowed_x_handles and excluded_x_handles cannot be used together");
	const tool = { type: "x_search" };
	if (allowed.length > 0) tool.allowed_x_handles = allowed;
	if (excluded.length > 0) tool.excluded_x_handles = excluded;
	if (args.from_date !== void 0 && args.from_date.trim().length > 0) tool.from_date = args.from_date.trim();
	if (args.to_date !== void 0 && args.to_date.trim().length > 0) tool.to_date = args.to_date.trim();
	if (args.enable_image_understanding === true) tool.enable_image_understanding = true;
	if (args.enable_video_understanding === true) tool.enable_video_understanding = true;
	return {
		query,
		tool
	};
}
/** Strip `@` prefixes, drop blanks, and enforce the provider's handle cap. */
function normalizeHandles(value, field) {
	if (value === void 0) return [];
	const handles = value.map((handle) => handle.trim().replace(/^@+/, "")).filter((handle) => handle.length > 0);
	if (handles.length > MAX_HANDLES) throw new Error(`x_search: ${field} supports at most ${MAX_HANDLES} handles`);
	return handles;
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Extract the answer text and citation URLs from a Responses payload: the
* `output_text` shortcut or message output parts for the answer, and both
* top-level `citations` and inline `url_citation` annotations for sources.
*/
function parseXSearchResponse(payload) {
	const body = isRecord$1(payload) ? payload : {};
	let answer = typeof body.output_text === "string" ? body.output_text.trim() : "";
	const citations = [];
	const push = (url) => {
		if (typeof url === "string" && url.length > 0 && !citations.includes(url)) citations.push(url);
	};
	if (Array.isArray(body.citations)) for (const citation of body.citations) push(citation);
	const parts = [];
	if (Array.isArray(body.output)) for (const item of body.output) {
		if (!isRecord$1(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (!isRecord$1(part)) continue;
			if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string" && part.text.trim().length > 0) parts.push(part.text.trim());
			if (Array.isArray(part.annotations)) {
				for (const annotation of part.annotations) if (isRecord$1(annotation) && annotation.type === "url_citation") push(annotation.url);
			}
		}
	}
	if (answer.length === 0) answer = parts.join("\n\n");
	return {
		answer,
		citations
	};
}
/** Bound a call-card title's query. */
function truncate$2(text, max = 60) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}â€¦`;
}
/**
* Build the `x_search` tool definition.
* @param options - grok session source and fetch implementation.
* @returns the tool to register on `ctx.tools`.
*/
function createXSearchTool(options) {
	return defineTool({
		name: "x_search",
		description: "Search X (Twitter) posts, profiles, and threads using the grok subscription's hosted xAI x_search. Use this for current discussion, reactions, or claims on X rather than general web pages.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "What to look up on X."
			},
			allowed_x_handles: {
				type: "array",
				items: { type: "string" },
				description: "X handles to include exclusively (max 10)."
			},
			excluded_x_handles: {
				type: "array",
				items: { type: "string" },
				description: "X handles to exclude (max 10)."
			},
			from_date: {
				type: "string",
				description: "Optional start date in YYYY-MM-DD format."
			},
			to_date: {
				type: "string",
				description: "Optional end date in YYYY-MM-DD format."
			},
			enable_image_understanding: {
				type: "boolean",
				description: "Whether xAI should analyze images attached to matching posts."
			},
			enable_video_understanding: {
				type: "boolean",
				description: "Whether xAI should analyze videos attached to matching posts."
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					answer: {
						type: "string",
						required: true
					},
					citations: {
						type: "array",
						items: { type: "string" },
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
