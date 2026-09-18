			title: `image_generate: ${truncate$1(args.prompt)}`
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			content: result.content.filter((block) => block.type === "text")
		}),
		async execute(args, exec) {
			const fetchFn = options.fetchFn ?? fetch;
			const preferGrok = args.provider === "grok";
			const referenceImage = typeof args.reference_image === "string" ? args.reference_image.trim() : "";
			const codexReady = options.codexTokens !== void 0 && await options.codexTokens.hasSession();
			const grokReady = options.grokTokens !== void 0 && await options.grokTokens.hasSession();
			if (referenceImage.length > 0 && (preferGrok || !codexReady)) throw new Error("image_generate: reference_image requires a logged-in ChatGPT subscription (provider=gpt)");
			const useGrok = preferGrok ? grokReady : grokReady && !codexReady;
			const useCodex = !useGrok && codexReady;
			let response;
			if (useCodex && options.codexTokens !== void 0) {
				const session = await options.codexTokens.session();
				if (referenceImage.length > 0) {
					const imageData = await readFile(referenceImage);
					const lower = referenceImage.toLowerCase();
					const mediaType = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : lower.endsWith(".webp") ? "image/webp" : "image/png";
					response = await fetchFn(IMAGE_EDIT_URL, {
						method: "POST",
						headers: {
							"authorization": `Bearer ${session.accessToken}`,
							"chatgpt-account-id": session.accountId,
							"originator": "codex_cli_rs",
							"content-type": "application/json",
							"accept": "application/json"
						},
						body: JSON.stringify({
							prompt: args.prompt.trim(),
							model: IMAGE_GENERATE_MODEL,
							images: [{ image_url: `data:${mediaType};base64,${imageData.toString("base64")}` }],
							...args.size === void 0 ? {} : { size: args.size },
							...args.quality === void 0 ? {} : { quality: args.quality }
						}),
						signal: exec.signal
					});
				} else response = await fetchFn(IMAGE_GENERATE_URL, {
					method: "POST",
					headers: {
						"authorization": `Bearer ${session.accessToken}`,
						"chatgpt-account-id": session.accountId,
						"originator": "codex_cli_rs",
						"content-type": "application/json",
						"accept": "application/json"
					},
					body: JSON.stringify(buildImageGenerateBody(args)),
					signal: exec.signal
				});
			} else if (useGrok && options.grokTokens !== void 0) {
				const session = await options.grokTokens.session();
				response = await fetchFn(GROK_IMAGE_GENERATE_URL, {
					method: "POST",
					headers: {
						"authorization": `Bearer ${session.accessToken}`,
						"content-type": "application/json",
						"accept": "application/json"
					},
					body: JSON.stringify(buildGrokImageGenerateBody(args)),
					signal: exec.signal
				});
			} else {
				const manager = preferGrok ? options.grokTokens ?? options.codexTokens : options.codexTokens ?? options.grokTokens;
				if (manager === void 0) throw new Error("image_generate: no image provider is configured");
				await manager.session();
				throw new Error("image_generate: no image provider is logged in");
			}
			if (!response.ok) throw await httpLlmError(response, "image_generate");
			const images = parseImageGenerateResponse(await response.json());
			const directory = options.imagesDir ?? imagesDirectory();
			await mkdir(directory, { recursive: true });
			const paths = [];
			const mediaTypes = [];
			for (const [index, image] of images.entries()) {
				const mediaType = sniffImageMediaType(image.data);
				const path = join(directory, imageFileName(index, mediaType));
				await writeFile(path, image.data);
				paths.push(path);
				mediaTypes.push(mediaType);
			}
			const attachments = options.resolveAttachments?.();
			const imageCapable = attachments !== void 0 && await routeDeclaresImageInput(options.resolveLlm, exec);
			const refs = [];
			if (attachments !== void 0 && imageCapable) for (const [index, image] of images.entries()) {
				const ref = await attachments.saveImage({
					data: image.data,
					mediaType: mediaTypes[index],
					name: basename(paths[index])
				});
				refs.push({
					attachmentId: ref.attachmentId,
					mediaType: ref.mediaType,
					bytes: ref.bytes,
					width: ref.width,
					height: ref.height,
					...ref.name === void 0 ? {} : { name: ref.name }
				});
			}
			const revisedPrompt = images.find((image) => image.revisedPrompt !== void 0)?.revisedPrompt;
			return {
				paths,
				...refs.length > 0 ? { images: refs } : {},
				...revisedPrompt === void 0 ? {} : { revisedPrompt }
			};
		}
	});
}

//#endregion

//#region src/tools/video-generate.ts
/** Endpoint the generation request is posted to. */
const VIDEO_GENERATE_URL = "https://api.x.ai/v1/videos/generations";
/** The video model the grok subscription endpoint serves. */
const VIDEO_GENERATE_MODEL = "grok-imagine-video-1.5";
/** Polling endpoint for one generation request. */
function videoStatusUrl(requestId) {
	return `https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`;
}
/** Default delay between two status polls. */
const DEFAULT_POLL_INTERVAL_MS = 3e3;
/** Default overall deadline for one generation (submit â†’ done). */
const DEFAULT_MAX_WAIT_MS = 10 * 6e4;
/** xAI's supported clip length range in seconds. */
const DURATION_RANGE = {
	min: 1,
	max: 15
};
/**
* Assemble the request body from tool arguments (hand-checks the non-empty
* prompt and the duration range the schema DSL cannot express).
*/
function buildVideoGenerateBody(args) {
	const prompt = args.prompt.trim();
	if (prompt.length === 0) throw new Error("video_generate: prompt must be a non-empty string");
	if (args.duration !== void 0 && (!Number.isInteger(args.duration) || args.duration < DURATION_RANGE.min || args.duration > DURATION_RANGE.max)) throw new Error(`video_generate: duration must be an integer between ${String(DURATION_RANGE.min)} and ${String(DURATION_RANGE.max)} seconds`);
	const imageUrl = args.image_url?.trim();
	return {
		prompt,
		model: VIDEO_GENERATE_MODEL,
		...args.duration === void 0 ? {} : { duration: args.duration },
		...args.aspect_ratio === void 0 ? {} : { aspect_ratio: args.aspect_ratio },
		...args.resolution === void 0 ? {} : { resolution: args.resolution },
		...imageUrl === void 0 || imageUrl.length === 0 ? {} : { image: { url: imageUrl } }
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Extract the request id from the submit response. Throws when the payload
* carries none.
*/
function parseVideoStartResponse(payload) {
	const body = isRecord(payload) ? payload : {};
	if (typeof body.request_id !== "string" || body.request_id.length === 0) throw new Error("video_generate: the response carried no request_id");
	return body.request_id;
}
/**
* Decode one poll response. A `done` payload without a video URL and an
* unrecognized status both throw (the poll loop cannot make progress on
* either).
*/
function parseVideoStatusResponse(payload) {
	const body = isRecord(payload) ? payload : {};
	switch (body.status) {
		default: throw new Error(`video_generate: unexpected status ${JSON.stringify(body.status)}`);
	}
}
/** Directory the downloaded MP4 files are written to. */
function videosDirectory() {
	return dshHomePath("plugins", "subscriptions", "videos");
}
/** Timestamped, collision-safe file name for one generated video. */
function videoFileName() {
	return `video-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.mp4`;
}
/** Bound a call-card title's prompt. */
function truncate(text, max = 60) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}â€¦`;
}
/** Abort-aware sleep between two polls. */
function sleep(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("video_generate: aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Build the `video_generate` tool definition.
* @param options - grok session source, fetch implementation, and video directory.
* @returns the tool to register on `ctx.tools`.
*/
function createVideoGenerateTool(options) {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	return defineTool({
		name: "video_generate",
		description: `Generate a short video (1-15 seconds) with the grok subscription (${VIDEO_GENERATE_MODEL}) and save it as an MP4 file. Generation is asynchronous and may take a minute or more; the tool waits for completion and returns the saved file path. Optionally animate a still image by passing image_url (image-to-video).`,
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "What the video should show."
			},
			duration: {
				type: "integer",
				description: "Clip length in seconds (1-15); omit for the provider default."
			},
			aspect_ratio: {
				type: "string",
				enum: [
					"16:9",
					"9:16",
					"1:1",
					"4:3",
					"3:4",
					"3:2",
					"2:3"
				],
				description: "Output aspect ratio; omit for the provider default (16:9)."
			},
			resolution: {
				type: "string",
				enum: [
					"480p",
					"720p",
					"1080p"
				],
				description: "Output resolution; omit for the provider default (480p). Higher is slower."
			},
			image_url: {
				type: "string",
				description: "Optional public URL or base64 data URL of a JPEG/PNG/WebP image to animate (image-to-video); the image becomes the starting frame."
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					duration: { type: "number" }
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
