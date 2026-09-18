* @param tools - tool schemas from the request.
* @returns Responses `tools` array entries.
*/
function toResponsesTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/** Grok rejects oversized Responses payloads with HTTP 413. Keep the
 * newest human turns, preserve function-call/output pairs, and bound large
 * tool results before retrying instead of failing the whole agent turn. */
const GROK_BODY_SOFT_LIMIT = 900_000;
const GROK_BODY_HARD_LIMIT = 1_200_000;
const GROK_RETRY_BODY_LIMIT = 400_000;
const GROK_INPUT_BUDGET = 650_000;
const GROK_AGGRESSIVE_INPUT_BUDGET = 300_000;
const GROK_FINAL_INPUT_BUDGET = 180_000;
const GROK_MINIMAL_INPUT_BUDGET = 96_000;
const GROK_MINIMAL_FINAL_INPUT_BUDGET = 48_000;
const GROK_MAX_TOOL_OUTPUT_CHARS = 16_000;
const GROK_AGGRESSIVE_TOOL_OUTPUT_CHARS = 6_000;
const GROK_MINIMAL_TOOL_OUTPUT_CHARS = 2_000;
const GROK_MAX_ARGUMENT_CHARS = 24_000;
const GROK_AGGRESSIVE_ARGUMENT_CHARS = 8_000;
const GROK_MINIMAL_ARGUMENT_CHARS = 4_000;
const GROK_MAX_MESSAGE_TEXT_CHARS = 64_000;
const GROK_AGGRESSIVE_MESSAGE_TEXT_CHARS = 32_000;
const GROK_MINIMAL_MESSAGE_TEXT_CHARS = 12_000;
const GROK_MAX_INSTRUCTIONS_CHARS = 96_000;
const GROK_AGGRESSIVE_INSTRUCTIONS_CHARS = 48_000;
const GROK_MINIMAL_INSTRUCTIONS_CHARS = 16_000;
const GROK_MAX_IMAGE_CHARS = 320_000;

function utf8Bytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function shortenGrokText(value, maximum, keepTail = false) {
	if (typeof value !== "string" || value.length <= maximum) return value;
	if (maximum <= 0) return "";
	const marker = "\n…[older content omitted to fit Grok request]…\n";
	const room = Math.max(0, maximum - marker.length);
	if (keepTail) {
		const head = Math.min(Math.floor(room * 0.2), 2000);
		return value.slice(0, head) + marker + value.slice(-(room - head));
	}
	const head = Math.floor(room * 0.7);
	return value.slice(0, head) + marker + value.slice(-Math.max(0, room - head));
}
/** Keep a function-call argument syntactically valid when shortening history. */
function compactGrokArguments(value, maximum) {
	if (typeof value !== "string" || value.length <= maximum) return value;
	try {
		const normalized = JSON.stringify(JSON.parse(value));
		if (normalized.length <= maximum) return normalized;
	} catch {}
	return "{\"_dsh_history_truncated\":true}";
}
function compactGrokInputItem(item, level) {
	const aggressive = level === true || level === "aggressive" || level === "minimal";
	const minimal = level === "minimal";
	if (item?.type === "function_call_output") return {
		...item,
		output: shortenGrokText(item.output, minimal ? GROK_MINIMAL_TOOL_OUTPUT_CHARS : aggressive ? GROK_AGGRESSIVE_TOOL_OUTPUT_CHARS : GROK_MAX_TOOL_OUTPUT_CHARS, true)
	};
	if (item?.type === "function_call") return {
		...item,
		arguments: compactGrokArguments(item.arguments, minimal ? GROK_MINIMAL_ARGUMENT_CHARS : aggressive ? GROK_AGGRESSIVE_ARGUMENT_CHARS : GROK_MAX_ARGUMENT_CHARS)
	};
	if (item?.type !== "message" || !Array.isArray(item.content)) return item;
	const maximum = minimal ? GROK_MINIMAL_MESSAGE_TEXT_CHARS : aggressive ? GROK_AGGRESSIVE_MESSAGE_TEXT_CHARS : GROK_MAX_MESSAGE_TEXT_CHARS;
	let textBudget = minimal ? 16_000 : aggressive ? 48_000 : 96_000;
	const content = [];
	for (const part of item.content) {
		if (part?.type === "input_text" || part?.type === "output_text") {
			const limit = Math.min(maximum, textBudget);
			if (limit > 0) content.push({ ...part, text: shortenGrokText(part.text, limit) });
			textBudget -= Math.min(typeof part.text === "string" ? part.text.length : 0, limit);
			continue;
		}
		if (part?.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:") && (minimal || aggressive || part.image_url.length > GROK_MAX_IMAGE_CHARS)) {
			content.push({ type: "input_text", text: "[image omitted from Grok history to fit request limit]" });
			continue;
		}
		content.push(part);
	}
	return { ...item, content };
}
function grokUserTurnStarts(input) {
	const starts = [];
	for (let i = 0; i < input.length; i++) if (input[i]?.type === "message" && input[i].role === "user") starts.push(i);
	return starts;
}
function grokSuffixStartWithToolPairs(input, start) {
	let first = start;
	const wanted = new Set(input.slice(start).filter((item) => item?.type === "function_call_output" && typeof item.call_id === "string").map((item) => item.call_id));
	if (wanted.size === 0) return first;
	for (let i = 0; i < start; i++) if (input[i]?.type === "function_call" && wanted.has(input[i].call_id)) first = Math.min(first, i);
	return first;
}
/** Group a function call with its output so suffix trimming never sends an orphan. */
function grokInputUnits(input, start) {
	const outputs = new Map();
	for (let i = start; i < input.length; i++) {
		const item = input[i];
		if (item?.type === "function_call_output" && typeof item.call_id === "string") outputs.set(item.call_id, i);
	}
	const used = new Set();
	const units = [];
	for (let i = start; i < input.length; i++) {
		if (used.has(i)) continue;
		const item = input[i];
		if (item?.type === "function_call" && typeof item.call_id === "string") {
			const output = outputs.get(item.call_id);
			if (output !== void 0) {
				used.add(i);
				used.add(output);
				units.push([i, output]);
				continue;
			}
		}
		used.add(i);
		units.push([i, i]);
	}
	return units;
}
function grokSuffixWithinBytes(input, start, maximumBytes) {
	const units = grokInputUnits(input, start);
	const selected = [];
	let bytes = 2;
	for (let i = units.length - 1; i >= 0; i--) {
		const [from, to] = units[i];
		const unitBytes = utf8Bytes(input.slice(from, to + 1));
		if (selected.length === 0 || bytes + unitBytes <= maximumBytes) {
			for (let index = from; index <= to; index++) selected.push(index);
			bytes += unitBytes;
		}
	}
	selected.sort((a, b) => a - b);
	return selected.map((index) => input[index]);
}
function compactGrokInput(input, maximumBytes, aggressive) {
	if (!Array.isArray(input) || utf8Bytes(input) <= maximumBytes) return input;
	const compacted = input.map((item) => compactGrokInputItem(item, aggressive));
	const starts = grokUserTurnStarts(input);
	const candidates = starts.length > 0 ? [Math.min(4, starts.length), Math.min(2, starts.length), 1] : [0];
	for (const count of candidates) {
		const rawStart = starts.length > 0 ? starts[Math.max(0, starts.length - count)] : Math.max(0, input.length - 24);
		const start = grokSuffixStartWithToolPairs(input, rawStart);
		const candidate = grokSuffixWithinBytes(compacted, start, maximumBytes);
		if (utf8Bytes(candidate) <= maximumBytes) return candidate;
	}
	const rawStart = starts.length > 0 ? starts[starts.length - 1] : Math.max(0, input.length - 8);
	return grokSuffixWithinBytes(compacted, grokSuffixStartWithToolPairs(input, rawStart), maximumBytes);
}
function compactGrokSchema(value, level) {
	const aggressive = level === true || level === "aggressive" || level === "minimal";
	const minimal = level === "minimal";
	if (Array.isArray(value)) return value.map((entry) => compactGrokSchema(entry, level));
	if (value === null || typeof value !== "object") return value;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "examples" || key === "example" || key === "$comment" || aggressive && key === "default") continue;
		if (key === "description") {
			result[key] = shortenGrokText(entry, minimal ? 120 : aggressive ? 400 : 2000);
			continue;
		}
		if (key === "title") {
			result[key] = shortenGrokText(entry, minimal ? 100 : 200);
			continue;
		}
		result[key] = compactGrokSchema(entry, level);
	}
	return result;
}
function compactGrokTools(tools, level = false) {
	if (!Array.isArray(tools)) return tools;
	const minimal = level === "minimal";
	const aggressive = level === true || level === "aggressive" || minimal;
	return tools.map((tool) => ({
		...tool,
		description: typeof tool?.description === "string" ? shortenGrokText(tool.description, minimal ? 120 : aggressive ? 400 : 4000) : tool?.description,
		parameters: compactGrokSchema(tool?.parameters, level)
	}));
}
function grokAvailableOutputTokens(options, instructions, input, tools) {
	if (typeof options.maxTokens !== "number" || !Number.isFinite(options.maxTokens)) return void 0;
	const estimatedInputTokens = Math.ceil(utf8Bytes({ instructions, input, tools }) / 3);
	const available = GROK_CONTEXT_WINDOW - estimatedInputTokens - 1024;
	if (available <= 0) return 1024;
	return Math.max(1024, Math.min(Math.floor(options.maxTokens), available));
}
function makeGrokBody(options, instructions, input, tools) {
	const maxOutputTokens = grokAvailableOutputTokens(options, instructions, input, tools);
	return {
		model: options.model,
		...instructions === void 0 ? {} : { instructions },
		input,
		...tools !== void 0 && tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {},
		...maxOutputTokens === void 0 ? {} : { max_output_tokens: maxOutputTokens },
		...options.reasoningEffort !== void 0 ? { reasoning: { effort: String(options.reasoningEffort) } } : {},
		store: false,
		stream: true
	};
}
function buildGrokBody(options, messages, compactLevel) {
	let { instructions, input } = toResponsesInput(messages, options.system);
	let tools = options.tools !== void 0 && options.tools.length > 0 ? toResponsesTools(options.tools) : void 0;
	let body = makeGrokBody(options, instructions, input, tools);
	const minimal = compactLevel === "minimal";
	const aggressive = compactLevel === "aggressive" || minimal;
	if (aggressive || utf8Bytes(body) > GROK_BODY_SOFT_LIMIT) {
		instructions = shortenGrokText(instructions, minimal ? GROK_MINIMAL_INSTRUCTIONS_CHARS : aggressive ? GROK_AGGRESSIVE_INSTRUCTIONS_CHARS : GROK_MAX_INSTRUCTIONS_CHARS);
		input = compactGrokInput(input, minimal ? GROK_MINIMAL_INPUT_BUDGET : aggressive ? GROK_AGGRESSIVE_INPUT_BUDGET : GROK_INPUT_BUDGET, minimal ? "minimal" : aggressive);
		tools = compactGrokTools(tools, minimal ? "minimal" : aggressive);
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (utf8Bytes(body) > GROK_BODY_SOFT_LIMIT) {
		instructions = shortenGrokText(instructions, minimal ? 8_000 : GROK_AGGRESSIVE_INSTRUCTIONS_CHARS);
		input = compactGrokInput(input, minimal ? GROK_MINIMAL_FINAL_INPUT_BUDGET : GROK_FINAL_INPUT_BUDGET, "minimal");
