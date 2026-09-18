	const catalog = resolveCatalog(config.models);
	const overridden = new Set(PROVIDER_IDS.filter((provider) => (config.models?.[provider]?.length ?? 0) > 0));
	const flows = new OAuthFlowManager();

	const onWarn = (message) => {
		ctx.logger.warn(`dsha-grok-provider: ${message}`);
	};
	const resolveAttachments = () => ctx.get("attachments");
	const handles = /* @__PURE__ */ new Map();
	const authChanged = (provider) => {
		handles.get(provider)?.replace([provider]);
	};
	let codexTokens;
	let claudeTokens;
	let grokTokens;
	const usageFetchers = {};
	const speedBySession = /* @__PURE__ */ new Map();
	let codexAdapter;
	for (const provider of providers) switch (provider) {
		case "grok": {
			const tokens = new TokenManager({
				displayName: "Grok (Subscription)",
				preemptMs: GROK_PREEMPT_MS,
				load: () => getSession("grok"),
				save: (session) => saveSession("grok", session),
				remove: () => deleteSession("grok"),
				refresh: refreshGrok,
				isPermanent: isGrokPermanentRefreshError,
				onRemoved: () => {
					authChanged("grok");
				}
			});
			grokTokens = tokens;
			usageFetchers.grok = async (signal) => fetchGrokUsage(await tokens.session(), fetch, signal);
			handles.set("grok", ctx.llm.registerAdapter(["grok"], new GrokAdapter({
				models: catalog.grok,
				streamIdleTimeoutMs,
				tokens,
				discovery: !overridden.has("grok"),
				onWarn,
				resolveAttachments,
				catalogStore: catalogStore("grok")
			})));
			break;
		}
}
	registerAuthRpc(ctx, new SubscriptionsAuthController(flows, authChanged, resolveAttachments, usageFetchers), {
		async speed(sessionId) {
			return {
				tier: speedBySession.get(sessionId) ?? "standard",
				fastModels: await codexAdapter?.fastCapableModels() ?? []
			};
		},
		async setSpeed(sessionId, tier) {
			if (tier === "standard") speedBySession.delete(sessionId);
			else speedBySession.set(sessionId, tier);
		}
	});
	if (claudeTokens !== void 0) {
		const syncTimer = setInterval(() => {
			claudeTokens?.session().catch(() => {});
		}, 5 * 6e4);
		ctx.effect(() => () => {
			clearInterval(syncTimer);
		}, "dsha-grok-provider: claude background sync timer");
	}
	ctx.inject(["tools"], (toolsCtx) => {
		if (grokTokens !== void 0) {
			toolsCtx.tools.register(createXSearchTool({ tokens: grokTokens }));
			toolsCtx.tools.register(createVideoGenerateTool({ tokens: grokTokens }));
		}
		if (codexTokens !== void 0 || grokTokens !== void 0) toolsCtx.tools.register(createImageGenerateTool({
			...codexTokens === void 0 ? {} : { codexTokens },
			...grokTokens === void 0 ? {} : { grokTokens },
			resolveAttachments,
			resolveLlm: () => ctx.get("llm")
		}));
	});
}

//#endregion

export { Config, DEFAULT_STREAM_IDLE_TIMEOUT_MS, apply, inject, name };
