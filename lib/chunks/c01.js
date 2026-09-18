import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, ToolCallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, attributionHeaders, errorChain, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";


//#region src/auth/pkce.ts
/**
* Base64url-encode without padding.
* @param buffer - raw bytes.
* @returns the RFC 4648 Â§5 encoding.
*/
function base64url(buffer) {
	return buffer.toString("base64url");
}
/**
* Mint a fresh PKCE pair (32-byte verifier, S256 challenge).
* @returns the pair for one authorization attempt.
*/
function createPkce() {
	const verifier = base64url(randomBytes(32));
	return {
		verifier,
		challenge: base64url(createHash("sha256").update(verifier).digest())
	};
}
/**
* Mint a URL-safe random token (default 16 bytes) for OAuth `state`.
* @param bytes - entropy length.
* @returns base64url-encoded random bytes.
*/
function randomToken(bytes = 32) {
	return base64url(randomBytes(bytes));
}
/**
* Mint lowercase-hex random bytes (for Grok's `nonce` parameter).
* @param bytes - entropy length; the hex string is twice as long.
* @returns hex-encoded random bytes.
*/
function randomHex(bytes = 8) {
	return randomBytes(bytes).toString("hex");
}

//#endregion

//#region src/auth/oauth-flow.ts
/** Default attempt lifetime: three minutes for the user to complete login. */
const DEFAULT_FLOW_TIMEOUT_MS = 18e4;
const SUCCESS_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Login successful</title></head><body style=\"font-family:sans-serif\"><h1>Login successful</h1><p>You can close this tab and return to DeepSeek Harness.</p></body></html>";
function failurePage(detail) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head><body style="font-family:sans-serif"><h1>Login failed</h1><p>${detail.replace(/[<>&]/g, "")}</p></body></html>`;
}
/**
* Loopback addresses one listen host covers. `localhost` resolves to ::1 or
* 127.0.0.1 depending on the client, and Node binds exactly one of them per
* listen call â€” a browser picking the other family gets connection-refused
* and the login times out, so both families must serve the callback.
*/
function listenHosts(host) {
	return host === "localhost" ? ["127.0.0.1", "::1"] : [host];
}
/** True when the address family does not exist on this machine (safe to skip), unlike a taken port. */
function familyUnavailable(error) {
	const code = error.code;
	return code === "EADDRNOTAVAIL" || code === "EPROTONOSUPPORT";
}
/**
* Listen on the first port of the spec free on every loopback family;
* rejects when every port fails. Ephemeral ports (0) are retried so each
* family can be re-bound onto the first family's assigned port.
*/
async function listen(handler, spec) {
	const hosts = listenHosts(spec.host);
	const candidates = spec.ports.flatMap((port) => port === 0 ? [
		0,
		0,
		0
	] : [port]);
	let lastError;
	for (const candidate of candidates) {
		const servers = [];
		let port = candidate;
		let unusable = false;
		for (const host of hosts) {
			const server = createServer(handler);
			try {
				await new Promise((resolve, reject) => {
					const onError = (error) => reject(error);
					server.once("error", onError);
					server.listen(port, host, () => {
						server.removeListener("error", onError);
						resolve();
					});
				});
				const address = server.address();
				if (address === null) throw new Error(`callback server on ${host}:${port} has no address`);
				if (port === 0) port = address.port;
				servers.push(server);
			} catch (error) {
				server.close();
				if (familyUnavailable(error)) continue;
				lastError = error;
				unusable = true;
				break;
			}
		}
		if (unusable || servers.length === 0) {
			for (const server of servers) server.close();
			continue;
		}
		return {
			servers,
			port
		};
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`callback server could not listen on ${spec.host} (ports ${spec.ports.join(", ")})`);
}
/**
* Own the set of in-flight login attempts, keyed by provider. One attempt per
* provider at a time; an attempt removes itself when it settles.
*/
var OAuthFlowManager = class {
	attempts = /* @__PURE__ */ new Map();
	/**
	* Whether a login attempt is running for one provider.
	* @param provider - the provider route.
	* @returns true while an attempt is waiting for its code.
	*/
	isBusy(provider) {
		return this.attempts.has(provider);
	}
	/**
	* The pending attempt for one provider, when any.
	* @param provider - the provider route.
	* @returns the in-flight attempt, or `undefined`.
	*/
	pending(provider) {
		return this.attempts.get(provider);
	}
	/**
	* Start a login attempt: mint PKCE/state, open the loopback callback
	* server, and build the authorize URL.
	* @param provider - the provider route (one attempt at a time).
	* @param spec - static flow facts for this provider.
	* @returns the live attempt; its `waitCode()` settles the login.
	* @throws when an attempt is already running or no callback port is free.
	*/
	async start(provider, spec) {
		if (this.attempts.has(provider)) throw new Error(`a ${provider} login attempt is already in progress`);
		if (this.attempts.size >= 3) throw new Error("too many concurrent login attempts in progress (max 3)");
		const input = {
			redirectUri: "",
			state: randomToken(16),
			pkce: createPkce(),
			nonce: randomHex(8)
		};
		const timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
		let resolveCode;
		let rejectCode;
		const codePromise = new Promise((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});
		let settled = false;
		let timer;
		let servers = [];
		const handler = (request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== spec.callbackPath) {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("not found");
				return;
			}
			const errorDescription = url.searchParams.get("error_description") ?? url.searchParams.get("error");
			if (errorDescription !== null) {
				response.writeHead(200, { "content-type": "text/html" });
				response.end(failurePage(errorDescription));
				settle(/* @__PURE__ */ new Error(`authorization failed: ${errorDescription}`));
				return;
			}
			if (url.searchParams.get("state") !== input.state) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("state mismatch");
				return;
			}
			const code = url.searchParams.get("code");
			if (code === null || code.length === 0) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("missing authorization code");
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(SUCCESS_PAGE);
			settle(void 0, code);
		};
		const settle = (error, code) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			for (const server of servers) {
				server.close();
				server.closeAllConnections();
			}
			this.attempts.delete(provider);
			if (error !== void 0) rejectCode(error);
			else if (code !== void 0) resolveCode(code);
		};
		const bound = await listen(handler, spec.listen);
		servers = bound.servers;
		input.redirectUri = `http://${spec.listen.host}:${bound.port}${spec.callbackPath}`;
		timer = setTimeout(() => {
			settle(/* @__PURE__ */ new Error(`login timed out after ${Math.round(timeoutMs / 1e3)}s`));
		}, timeoutMs);
		timer.unref();
		const attempt = {
			authorizeUrl: spec.buildAuthorizeUrl(input),
			redirectUri: input.redirectUri,
			pkce: input.pkce,
			state: input.state,
			waitCode: () => codePromise,
			manual(rawInput) {
				if (settled) throw new Error(`the ${provider} login attempt already finished`);
				const trimmed = rawInput.trim();
				let code;
				let pastedState;
				if (/^https?:\/\//i.test(trimmed)) {
					const url = new URL(trimmed);
					code = url.searchParams.get("code") ?? void 0;
					pastedState = url.searchParams.get("state") ?? void 0;
				} else if (trimmed.includes("code=")) {
					const params = new URLSearchParams(trimmed);
					code = params.get("code") ?? void 0;
					pastedState = params.get("state") ?? void 0;
				} else if (trimmed.length > 0 && !/\s/.test(trimmed)) code = trimmed;
				if (code === void 0 || code.length === 0) throw new Error("no authorization code found in the pasted input");
				if (pastedState !== void 0 && pastedState !== input.state) throw new Error("state mismatch: the pasted URL belongs to a different login attempt");
				settle(void 0, code);
			},
			cancel() {
				settle(/* @__PURE__ */ new Error("login cancelled"));
			}
		};
		this.attempts.set(provider, attempt);
		return attempt;
	}
};


//#endregion

//#region src/auth/store.ts
/** Every provider route, in display order. */
const PROVIDER_IDS = [
	"grok"
];
/**
* Absolute path of the auth store file.
* @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
*/
function authFilePath() {
	return dshHomePath("plugins", "subscriptions", "auth.json");
}
/** Store location used before the plugin was renamed; migrated on first read. */
function legacyAuthFilePath() {
	return dshHomePath("plugins", "router", "auth.json");
}
/** Check that one durable entry carries the fields every session needs. */
function assertSessionShape(provider, value) {
	if (typeof value !== "object" || value === null) throw new Error(`subscriptions auth store: entry "${provider}" is not an object; fix or delete the store file`);
	const entry = value;
