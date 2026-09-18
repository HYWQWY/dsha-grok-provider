	*   when the refresh grant is permanently rejected.
	*/
	async session(forceRefresh = false) {
		const session = await this.options.load();
		if (session === void 0) throw new LlmError(`dsha-grok-provider: not logged in to ${this.options.displayName}; log in via Settings â†’ Subscriptions in the dsh web app`, "MISSING_CREDENTIAL");
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
				throw new LlmError(`${this.options.displayName} login expired or was revoked; log in again via Settings â†’ Subscriptions`, "INVALID_CREDENTIAL", { cause: error });
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
* cache goes stale. `listModels` awaits freshness via {@link get};
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
	if (raw.inputModalities !== void 0 && (!Array.isArray(raw.inputModalities) || raw.inputModalities.length === 0 || raw.inputModalities.some((modality) => modality !== "text" && modality !== "image"))) return void 0;
	const reasoning = raw.reasoning === void 0 ? void 0 : sanitizeReasoning(raw.reasoning);
	if (raw.reasoning !== void 0 && reasoning === void 0) return void 0;
	const thinkingType = raw.thinkingType;
	if (thinkingType !== void 0 && thinkingType !== "enabled" && thinkingType !== "adaptive") return void 0;
	const fastTier = raw.fastTier;
	if (fastTier !== void 0 && typeof fastTier !== "boolean") return void 0;
	return {
		id: raw.id,
		name: raw.name,
		...raw.description === void 0 ? {} : { description: raw.description },
		...raw.contextWindow === void 0 ? {} : { contextWindow: raw.contextWindow },
		...raw.priority === void 0 ? {} : { priority: raw.priority },
		...raw.apiId === void 0 ? {} : { apiId: raw.apiId },
		...raw.maxTokens === void 0 ? {} : { maxTokens: raw.maxTokens },
		...raw.inputModalities === void 0 ? {} : { inputModalities: [...raw.inputModalities] },
		...reasoning === void 0 ? {} : { reasoning },
		...thinkingType === void 0 ? {} : { thinkingType },
		...fastTier === void 0 ? {} : { fastTier }
	};
}
/**
* Validate one persisted snapshot. Strict: any malformed field drops the
* whole snapshot rather than repairing it â€” the next successful discovery
* rewrites the entry anyway.
* @param value - the raw per-provider file entry.
* @returns the validated snapshot, or undefined when unusable.
*/
function sanitizeSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return void 0;
	if (!Array.isArray(raw.models) || raw.models.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const entry of raw.models) {
		const model = sanitizeModel(entry);
		if (model === void 0 || seen.has(model.id)) return void 0;
		seen.add(model.id);
		models.push(model);
	}
	return {
		at: raw.at,
		models
	};
}
/** Read the whole file; missing or unparsable reads as an empty cache. */
async function readCatalogFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/** Persist the whole file atomically (tmp file + rename). */
async function writeCatalogFile(store, path) {
	await mkdir(dirname(path), { recursive: true, mode: 448 });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2));
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Build the durable half of one provider's catalog cache over the shared
* models.json file (concurrent writers are last-writer-wins, acceptable for
* a cache).
* @param provider - the provider route keying the file entry.
* @param path - store file path; defaults to {@link modelsFilePath}.
* @returns the persistence hooks for {@link ModelCatalogCache}.
*/
function catalogStore(provider, path = modelsFilePath()) {
	return {
		async load() {
			return sanitizeSnapshot((await readCatalogFile(path))[provider]);
		},
		async save(snapshot) {
			const store = await readCatalogFile(path);
