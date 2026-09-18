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
				type: "text",
				text: value.citations.length > 0 ? `${value.answer}\n\nSources:\n${value.citations.map((citation) => `- ${citation}`).join("\n")}` : value.answer
			}],
			presentationMeta: (_args, value) => ({
				answer: value.answer,
				citations: value.citations
			})
		},
		presentCall: (args) => ({
			card: "generic",
			title: `x_search: ${truncate$2(args.query)}`,
			kind: "search"
		}),
		presentResult: (_args, result) => {
			if (result.isError || !isRecord$1(result.meta)) return void 0;
			return {
				card: "web",
				kind: "search",
				sources: (Array.isArray(result.meta.citations) ? result.meta.citations : []).filter((citation) => typeof citation === "string").map((url) => ({ url })),
				...typeof result.meta.answer === "string" && result.meta.answer.length > 0 ? { answer: result.meta.answer } : {},
				truncated: false
			};
		},
		async execute(args, exec) {
			const request = buildXSearchRequest(args);
			const session = await options.tokens.session();
			const response = await (options.fetchFn ?? fetch)(X_SEARCH_URL, {
				method: "POST",
				headers: {
					"authorization": `Bearer ${session.accessToken}`,
					"content-type": "application/json",
					"accept": "application/json"
				},
				body: JSON.stringify({
					model: X_SEARCH_MODEL,
					input: [{
						role: "user",
						content: request.query
					}],
					tools: [request.tool],
					store: false
				}),
				signal: exec.signal
			});
			if (!response.ok) throw await httpLlmError(response, "x_search");
			return parseXSearchResponse(await response.json());
		}
	});
}

//#endregion

//#region src/tools/image-generate.ts
/** Endpoint the codex generation request is posted to. */
const IMAGE_GENERATE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
/** The image model the codex subscription endpoint serves. */
const IMAGE_GENERATE_MODEL = "gpt-image-2";
/** Endpoint the codex reference-image edit request is posted to. */
const IMAGE_EDIT_URL = "https://chatgpt.com/backend-api/codex/images/edits";
/** Endpoint the grok generation request is posted to. */
const GROK_IMAGE_GENERATE_URL = "https://api.x.ai/v1/images/generations";
/** The image model the grok subscription endpoint serves. */
const GROK_IMAGE_GENERATE_MODEL = "grok-imagine-image-2.0";
/**
* Assemble the codex request body from tool arguments (hand-checks the
* non-empty prompt the schema DSL cannot express).
*/
function buildImageGenerateBody(args) {
	const prompt = args.prompt.trim();
	if (prompt.length === 0) throw new Error("image_generate: prompt must be a non-empty string");
	return {
		prompt,
		model: IMAGE_GENERATE_MODEL,
		...args.size === void 0 ? {} : { size: args.size },
		...args.quality === void 0 ? {} : { quality: args.quality }
	};
}
/** The codex `size` values mapped onto grok aspect ratios. */
const GROK_ASPECT_RATIOS = {
	"1024x1024": "1:1",
	"1024x1536": "2:3",
	"1536x1024": "3:2",
	"auto": "auto"
};
/**
* Assemble the grok request body from the same tool arguments: `size` maps
* onto the nearest `aspect_ratio`, and `quality` folds into grok's low/medium
* pair (`high` â†’ `medium`, `auto` â†’ provider default).
*/
function buildGrokImageGenerateBody(args) {
	const prompt = args.prompt.trim();
	if (prompt.length === 0) throw new Error("image_generate: prompt must be a non-empty string");
	const quality = args.quality === "low" ? "low" : args.quality === "medium" || args.quality === "high" ? "medium" : void 0;
	return {
		prompt,
		model: GROK_IMAGE_GENERATE_MODEL,
		response_format: "b64_json",
		...args.size === void 0 ? {} : { aspect_ratio: GROK_ASPECT_RATIOS[args.size] },
		...quality === void 0 ? {} : { quality }
	};
}
/**
* Parse the generations response into decodable images. Throws when the
* payload carries no usable `b64_json` entries.
*/
function parseImageGenerateResponse(payload) {
	const body = typeof payload === "object" && payload !== null ? payload : {};
	const entries = Array.isArray(body.data) ? body.data : [];
	const images = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		if (typeof record.b64_json !== "string" || record.b64_json.length === 0) continue;
		images.push({
			data: Buffer.from(record.b64_json, "base64"),
			...typeof record.revised_prompt === "string" && record.revised_prompt.length > 0 ? { revisedPrompt: record.revised_prompt } : {}
		});
	}
	if (images.length === 0) throw new Error("image_generate: the response carried no image data");
	return images;
}
/** Directory the generated image files are written to. */
function imagesDirectory() {
	return dshHomePath("plugins", "subscriptions", "images");
}
/**
* Sniff a generated image's media type from its magic bytes (codex serves
* PNG; grok's format is undocumented, so trust the bytes). Unrecognized data
* defaults to PNG, matching the historical behavior.
*/
function sniffImageMediaType(data) {
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return "image/png";
}
/** File extension for one sniffed media type. */
const MEDIA_TYPE_EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp"
};
/** Timestamped, collision-safe file name for one generated image. */
function imageFileName(index, mediaType) {
	return `image-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}-${index}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`;
}
/** Bound a call-card title's prompt. */
function truncate$1(text, max = 60) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}â€¦`;
}
/**
* Non-throwing image-capability check for the calling route (read_image's
* gate, softened: a generated image that cannot enter history degrades to the
* text-only result instead of failing the call). Resolves the session's
* latest routed provider/model and answers whether the exact route declares
* image input; any resolution failure means "no".
*/
async function routeDeclaresImageInput(resolveLlm, exec) {
	const llm = resolveLlm?.();
	const routed = exec.agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? exec.agent?.options.provider;
	const model = routed?.model ?? exec.agent?.options.model;
	if (llm === void 0 || provider === void 0 || model === void 0) return false;
	try {
