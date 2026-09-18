				text: `Saved video to ${value.path}` + (value.duration === void 0 ? "" : ` (${String(value.duration)}s)`) + `\nTemporary provider URL (expires soon): ${value.url}`
			}],
			presentationMeta: (_args, value) => ({
				fileName: basename(value.path),
				...value.duration === void 0 ? {} : { duration: value.duration }
			})
		},
		presentCall: (args) => ({
			card: "generic",
			title: `video_generate: ${truncate(args.prompt)}`
		}),
		async execute(args, exec) {
			const body = buildVideoGenerateBody(args);
			const session = await options.tokens.session();
			const fetchFn = options.fetchFn ?? fetch;
			const headers = {
				"authorization": `Bearer ${session.accessToken}`,
				"accept": "application/json"
			};
			const submit = await fetchFn(VIDEO_GENERATE_URL, {
				method: "POST",
				headers: {
					...headers,
					"content-type": "application/json"
				},
				body: JSON.stringify(body),
				signal: exec.signal
			});
			if (!submit.ok) throw await httpLlmError(submit, "video_generate");
			const requestId = parseVideoStartResponse(await submit.json());
			const deadline = Date.now() + maxWaitMs;
			let done;
			for (;;) {
				await sleep(pollIntervalMs, exec.signal);
				const poll = await fetchFn(videoStatusUrl(requestId), {
					method: "GET",
					headers,
					signal: exec.signal
				});
				if (!poll.ok) throw await httpLlmError(poll, "video_generate");
				const status = parseVideoStatusResponse(await poll.json());
				if (status.status === "done") {
					done = status;
					break;
				}
				if (status.status === "failed" || status.status === "expired") throw new Error(`video_generate: generation ${status.status} (request ${requestId})` + (status.detail === void 0 ? "" : `: ${status.detail}`));
				if (Date.now() >= deadline) throw new Error(`video_generate: timed out after ${String(maxWaitMs)}ms waiting for request ${requestId}`);
			}
			const download = await fetchFn(done.url, {
				method: "GET",
				signal: exec.signal
			});
			if (!download.ok) throw await httpLlmError(download, "video_generate download");
			const data = Buffer.from(await download.arrayBuffer());
			const directory = options.videosDir ?? videosDirectory();
			await mkdir(directory, { recursive: true });
			const path = join(directory, videoFileName());
			await writeFile(path, data);
			return {
				path,
				url: done.url,
				...done.duration === void 0 ? {} : { duration: done.duration }
			};
		}
	});
}

//#endregion

//#region src/index.ts
const name = "dsha-grok-provider";
const inject = ["llm", "connection", "webServer"];
/** Default maximum provider idle time while one stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const providerIdSchema = z.union([
	"grok"
]);
const modelEntrySchema = z.object({
	id: z.string().required(),
	name: z.string(),
	apiId: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	inputModalities: z.array(z.union(["text", "image"]))
});
const Config = z.object({
	providers: z.array(providerIdSchema).default([
		"grok"
	]),
	streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	models: z.object({
		grok: z.array(modelEntrySchema)
	})
});
/** Built-in catalog used when the config does not override models. */
const DEFAULT_MODELS = {
	grok: [
		{ id: "grok-4.6", name: "Grok 4.6", contextWindow: 5e5 },
		{ id: "grok-4.5", name: "Grok 4.5", contextWindow: 5e5 },
		{ id: "grok-code-fast-1", name: "Grok Code Fast 1" }
	]
};
/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models) {
	const resolve = (provider) => {
		const configured = models?.[provider];
		return validateModels(configured !== void 0 && configured.length > 0 ? configured : DEFAULT_MODELS[provider], `${name}: models.${provider}`);
	};
	return {
		grok: resolve("grok")
	};
}
/** The display account of a stored session, for the status endpoint. */
function accountOf(provider, session) {
	if (session === void 0) return void 0;
	switch (provider) {
		case "grok": return session.account;
}
}
/**
* Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
* OAuth attempts in the background, feed pasted codes, cancel, log out, and
* answer usage lookups.
*/
var SubscriptionsAuthController = class {
	/** Last login failure per provider, surfaced as `detail` until the next success. */
	lastError = /* @__PURE__ */ new Map();
	constructor(flows, onAuthChanged, resolveAttachments, usageFetchers = {}) {
		this.flows = flows;

		this.onAuthChanged = onAuthChanged;
		this.resolveAttachments = resolveAttachments;
		this.usageFetchers = usageFetchers;
	}
	usage(provider, signal) {
		const fetcher = this.usageFetchers[provider];
		if (fetcher === void 0) return Promise.resolve({ supported: false });
		return fetcher(signal);
	}
	async readImage(ref, signal) {
		const attachments = this.resolveAttachments();
		if (attachments === void 0) throw new Error("no attachment service is mounted; generated-image bytes are unavailable");
		const stored = await attachments.readImage(ref, signal);
		return {
			mediaType: stored.ref.mediaType,
			dataBase64: Buffer.from(stored.data).toString("base64")
		};
	}
	async readVideo(name$1, signal) {
		return {
			mediaType: "video/mp4",
			dataBase64: (await readFile(join(videosDirectory(), name$1), { signal })).toString("base64")
		};
	}
	async status(provider) {
		const session = await getSession(provider);
		const account = accountOf(provider, session);
		const detail = this.lastError.get(provider);
		const busy = this.flows.isBusy(provider);
		const attempt = this.flows.pending(provider);
		return {
			loggedIn: session !== void 0,
			busy,
			...session === void 0 ? {} : { expiresAt: session.expiresAt },
			...account === void 0 ? {} : { account },
			...detail === void 0 ? {} : { detail },
			...attempt === void 0 ? {} : { authorizeUrl: attempt.authorizeUrl }
		};
	}
	async login(provider) {


		const spec = await grokFlow();
		const attempt = await this.flows.start(provider, spec);
		this.complete(provider, attempt);
		return { authorizeUrl: attempt.authorizeUrl };
	}
	/** Drive one attempt to a stored session; records failures for the status endpoint. */
	async complete(provider, attempt) {
		try {
			const code = await attempt.waitCode();
			const session = await this.exchange(provider, code, attempt);
			await this.persist(provider, session);
			this.lastError.delete(provider);
			this.onAuthChanged(provider);
		} catch (error) {
			if (!(error instanceof Error && error.message === "login cancelled")) this.lastError.set(provider, errorChain(error));
		}
	}
	exchange(provider, code, attempt) {
		switch (provider) {
			case "grok": return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge);
}
	}
	persist(provider, session) {
		switch (provider) {
			case "grok": return saveSession("grok", session);
}
	}
	manual(provider, input) {
		const attempt = this.flows.pending(provider);
		if (attempt === void 0) return Promise.reject(/* @__PURE__ */ new Error(`no ${provider} login attempt is in progress`));
		attempt.manual(input);
		return Promise.resolve();
	}
	cancel(provider) {
		this.flows.pending(provider)?.cancel();

		return Promise.resolve();
	}
	async logout(provider) {
		this.flows.pending(provider)?.cancel();

		await deleteSession(provider);
		this.lastError.delete(provider);
		this.onAuthChanged(provider);
	}
};
function apply(ctx, config) {
	const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])];
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`);
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
