/**
 * PLACEHOLDER — full lib/index.js (~123KB) could not be uploaded in this
 * executor turn due to MCP tool-argument size limits (~13KB embed ceiling).
 * Replace using create_or_update_file with content from
 * /workspace/dsha-grok-provider/lib/index.js (UTF-8, no BOM).
 * Prepared payload: /workspace/CREATE_OR_UPDATE_INDEX.json
 */
export const name = "dsha-grok-provider";
export const inject = ["llm", "connection", "webServer"];
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
export const Config = {};
export function apply() {
  throw new Error("dsha-grok-provider: lib/index.js is a placeholder; upload full source from /workspace/dsha-grok-provider/lib/index.js");
}
