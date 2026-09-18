import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

/** Split payload pieces — concatenated in order into the real ESM module. */
const PARTS = ["index.part01.js", "index.part02.js", "index.part03.js", "index.part04.js", "index.part05.js", "index.part06.js", "index.part07.js", "index.part08.js", "index.part09.js", "index.part10.js", "index.part11.js", "index.part12.js"];

const here = dirname(fileURLToPath(import.meta.url));
const source = PARTS.map((name) => readFileSync(join(here, name), "utf8")).join("");
const assembled = join(
  tmpdir(),
  `dsha-grok-provider-${process.pid}-${Date.now()}.mjs`,
);
writeFileSync(assembled, source, "utf8");
let mod;
try {
  mod = await import(pathToFileURL(assembled).href);
} finally {
  try {
    unlinkSync(assembled);
  } catch {
    // ignore cleanup races
  }
}

export const Config = mod.Config;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = mod.DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const apply = mod.apply;
export const inject = mod.inject;
export const name = mod.name;
