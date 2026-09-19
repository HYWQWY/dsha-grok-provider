* @param path - store file path; defaults to {@link authFilePath}.
* @returns the parsed session map.
*/
async function loadStore(path = authFilePath()) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		if (path !== authFilePath()) return {};
		try {
			text = await readFile(legacyAuthFilePath(), "utf8");
		} catch (legacyError) {
			if (legacyError.code === "ENOENT") return {};
			throw legacyError;
		}
		const migrated = parseStore(text, legacyAuthFilePath());
		await writeStore(migrated, path);
		await rm(legacyAuthFilePath(), { force: true });
		return migrated;
	}
	return parseStore(text, path);
}
/** Parse and validate store JSON read from `path`. */
function parseStore(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`);
	const store = parsed;
	for (const provider of PROVIDER_IDS) {
		const entry = store[provider];
		if (entry !== void 0) assertSessionShape(provider, entry);
	}
	return store;
}
/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store, path) {
	await mkdir(dirname(path), { recursive: true, mode: 448 });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 384 });
		await chmod(tmp, 384);
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Read one provider's session.
* @param provider - the provider route.
* @param path - store file path; defaults to {@link authFilePath}.
* @returns the stored session, or `undefined` when logged out.
*/
async function getSession(provider, path = authFilePath()) {
	return (await loadStore(path))[provider];
}
/**
* Write one provider's session, preserving the others.
* @param provider - the provider route.
* @param session - the fresh session from a login or refresh.
* @param path - store file path; defaults to {@link authFilePath}.
*/
async function saveSession(provider, session, path = authFilePath()) {
	const store = await loadStore(path);
	store[provider] = session;
	await writeStore(store, path);
}
/**
* Delete one provider's session (logout).
* @param provider - the provider route.
* @param path - store file path; defaults to {@link authFilePath}.
*/
async function deleteSession(provider, path = authFilePath()) {
	const store = await loadStore(path);
	if (store[provider] === void 0) return;
	delete store[provider];
	await writeStore(store, path);
}

//#endregion

//#region src/auth/rpc.ts
/** The RPC channel this plugin registers on the host connection. */
const SUBSCRIPTIONS_AUTH_CHANNEL = "/grok-sub-auth";
/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/;
/** Payload carried no usable provider id â€” an RPC client bug, not a server failure. */
var BadRequest = class extends Error {};
function ok(value) {
	return {
		ok: true,
		value
	};
}
function failure(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof BadRequest) return {
		ok: false,
		error: {
			code: "bad-request",
			message,
			details: { issues: [] }
		}
	};
	return {
		ok: false,
		error: {
			code: "internal",
			message,
			details: {}
		}
	};
}
function readProvider(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const provider = payload.provider;
	if (typeof provider !== "string" || !PROVIDER_IDS.includes(provider)) throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(", ")}`);
	return provider;
}
function readString(payload, field) {
	const value = payload[field];
	if (typeof value !== "string" || value.length === 0) throw new BadRequest(`payload.${field} must be a non-empty string`);
	return value;
}
/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload) {
	const tier = payload.tier;
	if (tier !== "standard" && tier !== "fast") throw new BadRequest("payload.tier must be \"standard\" or \"fast\"");
	return tier;
}
/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const record = payload;
	const attachmentId = record.attachmentId;
	if (typeof attachmentId !== "string" || attachmentId.length === 0) throw new BadRequest("payload.attachmentId must be a non-empty string");
	const mediaType = record.mediaType;
	if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.includes(mediaType)) throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(", ")}`);
	for (const field of [
		"bytes",
		"width",
		"height"
	]) {
		const value = record[field];
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new BadRequest(`payload.${field} must be a positive integer`);
	}
	const name$1 = record.name;
	if (name$1 !== void 0 && typeof name$1 !== "string") throw new BadRequest("payload.name must be a string when present");
	return {
		attachmentId: AttachmentId(attachmentId),
		mediaType,
		bytes: record.bytes,
		width: record.width,
		height: record.height,
		...name$1 === void 0 ? {} : { name: name$1 }
	};
}
/**
* Validate the `video` endpoint's payload into a bare file name. Rejecting
* anything with a path separator (the pattern allows none) pins every read
* inside the plugin's videos directory.
*/
function readVideoName(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const name$1 = payload.name;
	if (typeof name$1 !== "string" || !VIDEO_NAME_PATTERN.test(name$1)) throw new BadRequest("payload.name must be a bare .mp4 file name");
	return name$1;
}
/** Validate the session id both speed endpoints carry. */
function readSessionId(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	return readString(payload, "sessionId");
}
async function dispatch(controller, speed, endpoint, payload, signal) {
	switch (endpoint) {
		case "status": {
			const entries = await Promise.all(PROVIDER_IDS.map(async (provider) => [provider, await controller.status(provider).catch((error) => ({
				loggedIn: false,
				busy: false,
				detail: error instanceof Error ? error.message : String(error)
			}))]));
			return ok({ providers: Object.fromEntries(entries) });
		}
		case "login":
			return ok(await controller.login(readProvider(payload)));
		case "manual": {
			const provider = readProvider(payload);
			await controller.manual(provider, readString(payload, "input"));
			return ok({ ok: true });
		}
		case "cancel":
			await controller.cancel(readProvider(payload));
			return ok({ ok: true });
		case "logout":
			await controller.logout(readProvider(payload));
			return ok({ ok: true });
		case "usage":
			return ok(await controller.usage(readProvider(payload), signal));
		case "image":
			return ok(await controller.readImage(readImageRef(payload), signal));
		case "video":
			return ok(await controller.readVideo(readVideoName(payload), signal));
		case "speed":
			return ok(await speed.speed(readSessionId(payload)));
		case "setSpeed":
			await speed.setSpeed(readSessionId(payload), readSpeedTier(payload));
			return ok({ ok: true });
		default:
			throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`);
	}
}
/**
* Register the `/subscriptions-auth` RPC channel when a host connection exists.
* @param ctx - the plugin context (headless profiles have no `connection`).
* @param controller - the auth operations backing the endpoints.
* @param speed - the per-session speed-tier state backing the Speed toggle.
*/
/** Maximum JSON RPC request body accepted by the subscriptions-auth route. */
const SUBSCRIPTIONS_AUTH_MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Endpoint segment accepted by the RPC channel (mirrors dsh-client-connection). */
const SUBSCRIPTIONS_AUTH_ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
function subscriptionsAuthEndpointFromPath(pathname) {
	if (!pathname.startsWith(`${SUBSCRIPTIONS_AUTH_CHANNEL}/`)) return void 0;
	const endpoint = pathname.slice(SUBSCRIPTIONS_AUTH_CHANNEL.length + 1);
	if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !SUBSCRIPTIONS_AUTH_ENDPOINT_PATTERN.test(segment))) return;
	return endpoint;
}
function subscriptionsAuthReadBody(req, limitBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function subscriptionsAuthFullResponse(rpcId, result) {
	return JSON.stringify({
		type: "server-response",
		rpcId,
		result
	});
}
function subscriptionsAuthErrorResponse(rpcId, code, message, issues) {
	return subscriptionsAuthFullResponse(rpcId, {
		ok: false,
		error: {
			code,
			message,
			details: { issues: issues ?? [] }
		}
	});
}
/**
* Register the `/subscriptions-auth` RPC channel on the host web server.
*
* dsh-client-connection's `connection.rpc.handle` currently requires the
* Connection plugin root context to expose `webServer`, which it does not,
* so the channel registration throws and the browser gets HTTP 405. Register
* the same prefix route directly on `webServer` and speak the identical
* client-request/server-response JSON envelope that the web client uses.
*/
function registerAuthRpc(ctx, controller, speed) {
	ctx.inject(["connection", "webServer"], (ctx$1) => {
		const connection = ctx$1.get("connection");
		const webServer = ctx$1.webServer;
		const route = {
			kind: "prefix",
			path: SUBSCRIPTIONS_AUTH_CHANNEL,
			handler: async (req, res) => {
				try {
					if (connection !== void 0 && connection.requestRejection !== void 0) {
						const rejection = connection.requestRejection(req);
						if (rejection !== void 0) {
							res.writeHead(rejection);
							res.end(rejection === 401 ? "unauthorized" : "forbidden");
							return;
