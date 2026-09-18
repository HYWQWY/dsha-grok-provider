import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/** Split payload pieces — concatenated in order into the real ESM module. */
const PARTS = [
  "index.part01.js",
  "index.part02.js",
  "index.part03.js",
  "index.part04.js",
  "index.part05.js",
  "index.part06.js",
  "index.part07.js",
  "index.part08.js",
  "index.part09.js",
  "index.part10.js",
  "index.part11.js",
  "index.part12.js",
];

const HOST_PACKAGES = [
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-tools",
  "undici",
];

const here = dirname(fileURLToPath(import.meta.url));

function resolveHostPackageDir(name) {
  const candidates = [
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules",
    "/usr/local/lib/node_modules",
  ];
  for (const base of candidates) {
    const target = join(base, ...name.split("/"));
    if (existsSync(join(target, "package.json"))) return target;
  }
  try {
    const requireFromDsh = createRequire(
      "/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json",
    );
    return dirname(requireFromDsh.resolve(name + "/package.json"));
  } catch {
    return null;
  }
}

/** Map package name -> file URL of an entry Node can import. */
function resolveHostImportHref(name) {
  const dir = resolveHostPackageDir(name);
  if (!dir) return null;
  try {
    const requireFromPkg = createRequire(join(dir, "package.json"));
    return pathToFileURL(requireFromPkg.resolve(name)).href;
  } catch {
    // ESM-only packages: pick exports/main/module/index.js manually
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    let rel = null;
    const exp = pkg.exports;
    if (typeof exp === "string") rel = exp;
    else if (exp && typeof exp === "object") {
      const dot = exp["."] ?? exp;
      if (typeof dot === "string") rel = dot;
      else if (dot && typeof dot === "object") {
        rel = dot.import || dot.default || dot.require || null;
        if (rel && typeof rel === "object") rel = rel.import || rel.default || rel.require;
      }
    }
    if (!rel) rel = pkg.module || pkg.main || "index.js";
    if (typeof rel !== "string") rel = "index.js";
    const entry = join(dir, rel);
    if (existsSync(entry)) return pathToFileURL(entry).href;
  } catch {
    // ignore
  }
  const fallback = join(dir, "index.js");
  return existsSync(fallback) ? pathToFileURL(fallback).href : null;
}

function rewriteHostImports(source) {
  let out = source;
  for (const name of HOST_PACKAGES) {
    const href = resolveHostImportHref(name);
    if (!href) continue;
    // from "..."; and from '...'
    const reFrom = new RegExp(
      `(from\\s*)(["'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\2`,
      "g",
    );
    out = out.replace(reFrom, `$1$2${href}$2`);
    const reImport = new RegExp(
      `(import\\s*\\(\\s*)(["'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\2`,
      "g",
    );
    out = out.replace(reImport, `$1$2${href}$2`);
  }
  return out;
}

const source = rewriteHostImports(
  PARTS.map((name) => readFileSync(join(here, name), "utf8")).join(""),
);

// Keep the assembled module inside the plugin tree (not /tmp) so any
// remaining relative imports resolve next to the package.
const assembled = join(here, ".assembled.mjs");
writeFileSync(assembled, source, "utf8");

const mod = await import(`${pathToFileURL(assembled).href}?v=${Date.now()}`);

export const Config = mod.Config;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = mod.DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const apply = mod.apply;
export const inject = mod.inject;
export const name = mod.name;
