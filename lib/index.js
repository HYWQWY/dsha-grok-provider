import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const BUILD = "0.1.4";
const EXPECTED_SHA256 = "5edb0e3c6f47569b384f1f2746370a327538676157e533cc546aac98e009e1e2";
const PARTS = ["c01.js", "c02.js", "c03.js", "c04.js", "c05.js", "c06.js", "c07.js", "c08.js", "c09.js", "c10.js", "c11.js", "c12.js"];

const HOST_PACKAGES = [
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-tools",
  "undici",
];

const here = dirname(fileURLToPath(import.meta.url));
const chunksDir = join(here, "chunks");

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

function resolveHostImportHref(name) {
  const dir = resolveHostPackageDir(name);
  if (!dir) return null;
  try {
    const requireFromPkg = createRequire(join(dir, "package.json"));
    return pathToFileURL(requireFromPkg.resolve(name)).href;
  } catch {}
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
  } catch {}
  const fallback = join(dir, "index.js");
  return existsSync(fallback) ? pathToFileURL(fallback).href : null;
}

function rewriteHostImports(source) {
  let out = source;
  for (const name of HOST_PACKAGES) {
    const href = resolveHostImportHref(name);
    if (!href) continue;
    out = out.split('from "' + name + '"').join('from "' + href + '"');
    out = out.split('import("' + name + '"').join('import("' + href + '"');
  }
  return out;
}

const sourceRaw = PARTS.map((name) => readFileSync(join(chunksDir, name), "utf8")).join("");
const sha = createHash("sha256").update(sourceRaw, "utf8").digest("hex");
if (sha !== EXPECTED_SHA256) {
  throw new Error("dsha-grok-provider " + BUILD + ": chunk mismatch. Reinstall from GitHub (got " + sha.slice(0,12) + ").");
}
const source = rewriteHostImports(sourceRaw);
const assembled = join(here, ".assembled.mjs");
writeFileSync(assembled, source, "utf8");
const mod = await import(pathToFileURL(assembled).href + "?v=" + BUILD);

export const Config = mod.Config;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = mod.DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const apply = mod.apply;
export const inject = mod.inject;
export const name = mod.name;
