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
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (compactLevel !== void 0 && utf8Bytes(body) > GROK_RETRY_BODY_LIMIT) {
		// A 413 retry must be comfortably below xAI's limit even when the
		// original failure came mostly from tool schemas rather than history.
		instructions = shortenGrokText(instructions, 8_000);
		input = compactGrokInput(input, GROK_MINIMAL_FINAL_INPUT_BUDGET, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (compactLevel !== void 0 && utf8Bytes(body) > GROK_RETRY_BODY_LIMIT) {
		// Tool definitions are optional for this last-resort replay. Dropping
		// them is safer than sending another request that the provider rejects.
		instructions = shortenGrokText(instructions, 4_000);
		input = compactGrokInput(input, 24_000, "minimal");
		tools = void 0;
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (utf8Bytes(body) > GROK_BODY_HARD_LIMIT) {
		instructions = shortenGrokText(instructions, 4_000);
		input = compactGrokInput(input, 24_000, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	return body;
}
/**
* Map Responses usage to disjoint harness counts (cached input is subtracted
* out of `inputTokens` and reported as `cacheReadTokens`).
* @param usage - wire usage from `response.completed`.
* @returns harness token usage.
*/
function mapResponsesUsage(usage) {
	const cached = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.input_tokens - (cached ?? 0),
		outputTokens: usage.output_tokens,
		...cached !== void 0 ? { cacheReadTokens: cached } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
* Classify a Responses failure payload into a thrown LlmError.
* @param code - provider error code, when present.
* @param message - provider error message, when present.
* @returns the mapped error (context overflow, quota, otherwise SERVER).
*/
function responsesFailure(code, message) {
	const text = message ?? code ?? "the provider reported a failed response";
	const detail = `${code ?? ""} ${message ?? ""}`;
	if (code === "context_window_exceeded" || isContextWindowExceededError(detail)) return new LlmError(text, CONTEXT_WINDOW_EXCEEDED_CODE);
	if (code !== void 0 && /insufficient|quota/i.test(code) || isQuotaExceededError(detail)) return new LlmError(text, QUOTA_EXCEEDED_CODE);
	return new LlmError(text, "SERVER");
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock$1(block) {
	switch (block.kind) {
}
}
/**
* Push-model Responses SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes
* are allocated in first-seen order; `usage` is emitted before the terminal
* `finish`, and nothing is emitted after it. Terminal provider failures
* throw {@link LlmError}.
*/
var ResponsesStreamTranslator = class {
	blocks = /* @__PURE__ */ new Map();
	order = [];
	nextIndex = 0;
	sawToolCall = false;
	/** Set once `response.completed` produced the terminal finish chunk. */
	terminated = false;
	open(key, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(key, block);
		this.order.push(block);
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	textBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "text", chunks);
	}
	reasoningBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "reasoning", chunks);
	}
	close(key, chunks) {
		const block = this.blocks.get(key);
		if (block === void 0) return;
		this.blocks.delete(key);
		chunks.push({
			type: "block-end",
			index: block.index,
			block: closeBlock$1(block)
		});
	}
	/** Close every still-open block for one output item (prefix match on the key). */
	closeItem(itemId, chunks) {
		for (const key of [...this.blocks.keys()]) if (key.startsWith(`${itemId}:`)) this.close(key, chunks);
	}
	/** Close every still-open block (provider ended the response without done events). */
	closeAll(chunks) {
		for (const block of this.order) this.closeKeyIfOpen(block, chunks);
	}
	closeKeyIfOpen(block, chunks) {
		for (const [key, candidate] of this.blocks) if (candidate === block) {
			this.blocks.delete(key);
			chunks.push({
				type: "block-end",
				index: block.index,
				block: closeBlock$1(block)
			});
			return;
		}
