import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const here = fileURLToPath(new URL(".", import.meta.url));
const parts = [];
for (let i = 0; i < 13; i++) {
  parts.push(readFileSync(join(here, `index.part${i}.js.txt`), "utf8"));
}
const code = parts.join("");
const dir = join(tmpdir(), "dsha-grok-" + createHash("sha256").update(code).digest("hex").slice(0, 12));
mkdirSync(dir, { recursive: true });
const file = join(dir, "index.js");
writeFileSync(file, code);
const m = await import(pathToFileURL(file).href);
export const Config = m.Config;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = m.DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const apply = m.apply;
export const inject = m.inject;
export const name = m.name;
