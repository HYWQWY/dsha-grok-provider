		return await fetch(url, init);
	} catch (error) {
		if (!isDeadProxyError(error)) throw error;
		return await fetchDirect(url, init);
	}
}
function mapFetchFailure(label, error, watchdog, caller) {
	if (watchdog.timedOut()) return new LlmError(`${label} stream idle timeout`, "TIMEOUT", { cause: error });
	if (caller?.aborted === true) return new LlmError(`${label} request aborted by caller`, "ABORTED", { cause: error });
	if (error instanceof LlmError) return error;
	return new LlmError(`${label} request failed: ${causeText(error)}`, "TRANSPORT", { cause: error });
}
/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
var OAuthEndpointError = class extends Error {
	/** HTTP status of the token endpoint response. */
	status;
	/** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
	oauthCode;
	constructor(message, status, oauthCode) {
		super(message);
		this.name = "OAuthEndpointError";
		this.status = status;
		this.oauthCode = oauthCode;
	}
};
/**
* Read an OAuth JSON error body into an {@link OAuthEndpointError}.
* @param response - the failed token-endpoint response.
* @param label - diagnostic prefix naming the provider.
* @returns the error to throw.
*/
async function oauthEndpointError(response, label) {
	let oauthCode;
	let detail = "";
	try {
		const parsed = await response.json();
		oauthCode = typeof parsed.error === "string" ? parsed.error : void 0;
		detail = typeof parsed.error_description === "string" ? parsed.error_description : oauthCode ?? "";
	} catch {}
	return new OAuthEndpointError(detail.length > 0 ? `${label} token endpoint error (HTTP ${String(response.status)}): ${detail}` : `${label} token endpoint error (HTTP ${String(response.status)})`, response.status, oauthCode);
}
/**
* Per-provider session freshness: loads the stored session, refreshes
* proactively inside the preempt window or on demand after a 401, and
* coalesces concurrent refreshes behind one in-flight promise. Permanent
* refresh failures delete the stored session and surface INVALID_CREDENTIAL
* with a re-login hint; transient failures fall back to a still-valid token.
*/
var TokenManager = class {
	inflight;
	constructor(options) {
		this.options = options;
		this.options = options;
	}
	/**
	* Read the stored session without any refresh side effect. Catalog queries
	* (`listModels`) use this to decide whether the provider is logged in.
	* @returns the stored session, or `undefined` when logged out.
	*/
	peek() {
		return this.options.load();
	}
	/**
	* Whether a session is currently stored (cheap; never refreshes).
	* @returns true when logged in.
	*/
	async hasSession() {
		return await this.options.load() !== void 0;
	}
	/**
	* Resolve a usable session, refreshing proactively or on demand.
	* @param forceRefresh - refresh regardless of expiry (used after a 401).
	* @returns the persisted session to send.
	* @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
	*   when the refresh grant is permanently rejected.
	*/
	async session(forceRefresh = false) {
		const session = await this.options.load();
		if (session === void 0) throw new LlmError(`dsha-grok-provider: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions in the dsh web app`, "MISSING_CREDENTIAL");
		if (!forceRefresh && session.expiresAt - Date.now() > this.options.preemptMs) return session;
		this.inflight ??= this.doRefresh(session).finally(() => {
			this.inflight = void 0;
		});
		try {
			return await this.inflight;
		} catch (error) {
			if (this.options.isPermanent(error)) {
				await this.options.remove();
				this.options.onRemoved?.();
				throw new LlmError(`${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`, "INVALID_CREDENTIAL", { cause: error });
			}
			if (!forceRefresh && session.expiresAt > Date.now()) return session;
			throw error instanceof LlmError ? error : new LlmError(`${this.options.displayName} token refresh failed`, "AUTH", { cause: error });
		}
	}
	async doRefresh(session) {
		const current = await this.options.load();
		if (current !== void 0 && current.accessToken !== session.accessToken && current.expiresAt - Date.now() > this.options.preemptMs) return current;
		const next = await this.options.refresh(current ?? session);
		await this.options.save(next);
		return next;
	}
	/** Drop a session the resource server rejected after a forced refresh. */
	async invalidate() {
		this.inflight = void 0;
		await this.options.remove();
		this.options.onRemoved?.();
	}
};
/** How long a discovered catalog is trusted before re-fetching. */
const DISCOVERY_TTL_MS = 5 * 6e4;
/**
* Cache for one provider's discovered model catalog. The TTL only decides
* when to REFRESH; it never makes the cache forget: capability metadata
* (reasoning efforts) must stay stable for a session that selected an effort,
* or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
* cache goes stale. `listModels` awaits freshness via {@link get}`;
* `resolveModel` uses {@link resolve}, which serves the last-known catalog
* while a stale entry refreshes in the background, and only awaits the fetch
* when nothing is known yet. An optional {@link CatalogPersistence} seeds the
* last-known state across restarts and receives every successful fetch. A 401
* during a fetch must call {@link invalidate}.
*/
var ModelCatalogCache = class {
	entry;
	inflight;
	/** Settles once the persisted snapshot (when any) has been considered. */
	seeded;
	/** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
	seedDisabled = false;
	constructor(persistence, ttlMs = DISCOVERY_TTL_MS) {
		this.persistence = persistence;
		this.ttlMs = ttlMs;
	}
	/**
	* The cached catalog when fresh, without fetching.
	* @returns the cached models, or `undefined` when absent or stale.
	*/
	cached() {
		if (this.entry === void 0 || Date.now() - this.entry.at >= this.ttlMs) return void 0;
		return this.entry.models;
	}
	/** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
	ensureSeeded() {
		if (this.persistence === void 0) return Promise.resolve();
		this.seeded ??= this.persistence.load().then((snapshot) => {
			if (snapshot !== void 0 && this.entry === void 0 && !this.seedDisabled) this.entry = snapshot;
		}, () => void 0);
		return this.seeded;
	}
	/** Run (or join) the single in-flight fetch, updating memory and disk on success. */
	refresh(fetcher) {
		this.inflight ??= fetcher().then((models) => {
			const snapshot = {
				at: Date.now(),
				models
			};
			this.entry = snapshot;
			this.persistence?.save(snapshot).catch(() => void 0);
			return models;
		}).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/**
	* Return the cached catalog when fresh, otherwise fetch and cache it.
	* @param fetcher - performs the provider's model-list request.
	* @returns the discovered models.
	* @throws the fetcher's failure (the `listModels` caller warns and falls back).
	*/
	async get(fetcher) {
		await this.ensureSeeded();
		return this.cached() ?? this.refresh(fetcher);
	}
	/**
	* The models for capability resolution. A fresh cache answers directly; a
	* stale one answers immediately from the last-known catalog while a
	* background refresh runs (a mid-conversation `resolveModel` must neither
	* block on nor fail with the network); a cold cache awaits one fetch.
	* @param fetcher - performs the provider's model-list request.
	* @returns the models, or `undefined` when nothing is known (the caller
	*   falls back to its static metadata). Never throws.
	*/
	async resolve(fetcher) {
		await this.ensureSeeded();
		const fresh = this.cached();
		if (fresh !== void 0) return fresh;
		const known = this.entry?.models;
		if (known !== void 0) {
			this.refresh(fetcher).catch(() => void 0);
			return known;
		}
		try {
			return await this.refresh(fetcher);
		} catch {
			return;
		}
	}
	/** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
	invalidate() {
		this.entry = void 0;
		this.seedDisabled = true;
		this.persistence?.clear().catch(() => void 0);
	}
};

//#endregion

//#region src/providers/catalog-store.ts
/**
* Absolute path of the catalog store file.
* @returns `dshHomePath('plugins', 'subscriptions', 'models.json')`.
*/
function modelsFilePath() {
	return dshHomePath("plugins", "subscriptions", "models.json");
}
/** Validate one persisted reasoning block, or undefined when malformed. */
function sanitizeReasoning(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (!Array.isArray(raw.efforts) || raw.efforts.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const efforts = [];
	for (const entry of raw.efforts) {
		if (typeof entry !== "object" || entry === null) return void 0;
		const effort = entry;
		if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) return void 0;
		seen.add(effort.id);
		efforts.push({
			id: ReasoningEffortId(effort.id),
			name: effort.name,
			...effort.description === void 0 ? {} : { description: effort.description }
		});
	}
	if (raw.defaultEffort !== void 0 && (typeof raw.defaultEffort !== "string" || !seen.has(raw.defaultEffort))) return void 0;
	return {
		efforts,
		...raw.defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(raw.defaultEffort) }
	};
}
/** Validate one persisted model, or undefined when malformed. */
function sanitizeModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.name !== "string" || raw.name.length === 0 || raw.description !== void 0 && typeof raw.description !== "string" || raw.contextWindow !== void 0 && (typeof raw.contextWindow !== "number" || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0) || raw.priority !== void 0 && (typeof raw.priority !== "number" || !Number.isFinite(raw.priority))) return void 0;
	if (raw.apiId !== void 0 && (typeof raw.apiId !== "string" || raw.apiId.length === 0)) return void 0;
	if (raw.maxTokens !== void 0 && (typeof raw.maxTokens !== "number" || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)) return void 0;
