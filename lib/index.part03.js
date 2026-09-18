						res.writeHead(200, { "content-type": "application/json" });
						res.end(subscriptionsAuthErrorResponse(envelope.rpcId, "gateway/bad-request",
							`method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`, []));
						return;
					}
					const abort = new AbortController();
					res.on("close", () => {
						if (!res.writableEnded) abort.abort();
					});
					let result;
					try {
						result = await dispatch(controller, speed, endpoint, envelope.payload, abort.signal);
					} catch (error) {
						result = failure(error);
					}
					res.writeHead(200, { "content-type": "application/json" });
					res.end(subscriptionsAuthFullResponse(envelope.rpcId, result));
				} catch (error) {
					try {
						res.writeHead(500);
						res.end(`handler failure: ${String(error)}`);
					} catch {
						// Response already ended; nothing else to do.
					}
				}
			}
		};
		ctx$1.effect(() => webServer.register(route), "dsha-grok-provider: /subscriptions-auth rpc channel");
	});
}

//#endregion

//#region src/providers/common.ts
/**
* Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
* @param models - raw configured entries.
* @param label - diagnostic prefix naming the provider.
* @returns the validated entries.
*/
function validateModels(models, label) {
	const seen = /* @__PURE__ */ new Set();
	return models.map((model) => {
		if (model.id.length === 0) throw new Error(`${label}: catalog model ids must be non-empty`);
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`${label}: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (model.apiId !== void 0 && (typeof model.apiId !== "string" || model.apiId.length === 0)) throw new Error(`${label}: catalog model "${model.id}" apiId must be a non-empty string`);
		if (model.inputModalities !== void 0 && (model.inputModalities.length === 0 || model.inputModalities.some((modality) => modality !== "text" && modality !== "image"))) throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`);
		if (seen.has(model.id)) throw new Error(`${label}: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.apiId === void 0 ? {} : { apiId: model.apiId },
			...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
		};
	});
}
/**
* Build an LlmError from a non-2xx provider response, reading and truncating
* the body for the message and mapping the status to a stable code.
* @param response - the failed response.
* @param label - diagnostic prefix naming the provider API.
* @returns the classified error.
*/
async function httpLlmError(response, label) {
	let body = "";
	try {
		body = (await response.text()).slice(0, 500);
	} catch {}
	const locationBlocked = /user location is not supported for the api use|not currently available in your location|unsupported_location/i.test(body);
	const message = locationBlocked
		? `${label}: Google does not support Antigravity API use from this network location. Use a supported-region network exit and try again.`
		: body.length > 0 ? `${label} error (HTTP ${String(response.status)}): ${body}` : `${label} error (HTTP ${String(response.status)})`;
	let code;
	if (locationBlocked) code = "UNSUPPORTED_REGION";
	else if (response.status === 401 || response.status === 403) code = "AUTH";
	else if (isQuotaExceededError(body)) code = QUOTA_EXCEEDED_CODE;
	else if (response.status === 429) code = "RATE_LIMIT";
	else if (response.status === 400 && isContextWindowExceededError(body)) code = CONTEXT_WINDOW_EXCEEDED_CODE;
	else if (response.status === 408 || response.status === 504) code = "TIMEOUT";
	else if (response.status >= 500) code = "SERVER";
	else code = `HTTP_${String(response.status)}`;
	const retryAfter = response.headers.get("retry-after");
	let providerRetryAfterMs;
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) providerRetryAfterMs = seconds * 1e3;
	}
	return new LlmError(message, code, {
		status: response.status,
		...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs }
	});
}
/**
* Create an idle watchdog chained to the caller's signal.
* @param caller - the request's own abort signal, when present.
* @param timeoutMs - maximum idle interval while a stream read is outstanding.
* @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
*/
function idleWatchdog(caller, timeoutMs) {
	const controller = new AbortController();
	let expired = false;
	let timer;
	const arm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			expired = true;
			controller.abort(/* @__PURE__ */ new Error(`stream idle timeout after ${String(timeoutMs)}ms`));
		}, timeoutMs);
		timer.unref();
	};
	const onCallerAbort = () => controller.abort(caller?.reason);
	if (caller?.aborted === true) controller.abort(caller.reason);
	else caller?.addEventListener("abort", onCallerAbort, { once: true });
	arm();
	return {
		signal: controller.signal,
		pulse: arm,
		stop() {
			if (timer !== void 0) clearTimeout(timer);
			caller?.removeEventListener("abort", onCallerAbort);
		},
		timedOut: () => expired
	};
}
/**
* Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
* expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
* TRANSPORT with the cause chained.
* @param label - diagnostic prefix naming the provider API.
* @param error - the thrown value.
* @param watchdog - the request's idle watchdog.
* @param caller - the request's own abort signal, when present.
* @returns the classified error.
*/
function causeText(error) {
	if (error instanceof Error) {
		const extra = error.cause instanceof Error ? `: ${error.cause.message}` : "";
		return `${error.message}${extra}`;
	}
	return String(error);
}
function isDeadProxyError(error) {
	const text = causeText(error);
	return /ECONNREFUSED[^\n]*7890|connect ECONNREFUSED 127\.0\.0\.1:7890|ECONNREFUSED 127\.0\.0\.1:1080|other side closed|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|socket hang up|ECONNRESET|EPIPE|ETIMEDOUT/i.test(text);
}
/** Gemini 3 requires a thought_signature on every replayed functionCall; this dummy is accepted when the original was stripped. */
const ANTIGRAVITY_DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
/** sessionId:callId → signature captured from the last model turn. */
const antigravityThoughtSignatures = /* @__PURE__ */ new Map();
function antigravitySignatureKey(sessionId, callId) {
	if (typeof callId !== "string" || callId.length === 0) return;
	return `${sessionId ?? ""}:${callId}`;
}
function rememberAntigravityThoughtSignature(sessionId, callId, signature) {
	const key = antigravitySignatureKey(sessionId, callId);
	if (key === void 0 || typeof signature !== "string" || signature.length === 0) return;
	antigravityThoughtSignatures.set(key, signature);
}
async function fetchDirect(url, init) {
	const { Agent, fetch: undiciFetch } = await import("undici");
	const dispatcher = new Agent({
		headersTimeout: 600000,
		bodyTimeout: 0,
		keepAliveTimeout: 60000,
		keepAliveMaxTimeout: 600000
	});
	return undiciFetch(url, { ...init, dispatcher });
}
async function fetchProxyThenDirect(url, init) {
	try {
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
