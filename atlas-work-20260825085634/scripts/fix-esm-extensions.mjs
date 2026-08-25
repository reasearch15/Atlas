#!/usr/bin/env node
/**
 * Rewrites TypeScript-emitted ESM relative imports/exports to include .js
 * so Node can load packages with "type": "module" without a bundler.
 *
 * Usage: node scripts/fix-esm-extensions.mjs <dist-dir>
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const targetDir = resolve(process.argv[2] ?? "dist");

if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
  console.error(`fix-esm-extensions: missing directory ${targetDir}`);
  process.exit(1);
}

const importExportPattern =
  /((?:import|export)\s+(?:[^"'`]*?\s+from\s+)?|import\s*\(\s*)(["'])(\.[^"'`]+)\2/g;

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listJsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string}
 */
function resolveSpecifier(fromFile, specifier) {
  if (extname(specifier) === ".js" || extname(specifier) === ".json" || extname(specifier) === ".node") {
    return specifier;
  }

  const basePath = resolve(dirname(fromFile), specifier);
  if (existsSync(`${basePath}.js`)) {
    return `${specifier}.js`;
  }
  if (existsSync(join(basePath, "index.js"))) {
    return `${specifier}/index.js`;
  }
  return specifier;
}

let changedFiles = 0;

for (const file of listJsFiles(targetDir)) {
  const original = readFileSync(file, "utf8");
  const updated = original.replace(importExportPattern, (match, prefix, quote, specifier) => {
    const next = resolveSpecifier(file, specifier);
    if (next === specifier) {
      return match;
    }
    return `${prefix}${quote}${next}${quote}`;
  });

  if (updated !== original) {
    writeFileSync(file, updated, "utf8");
    changedFiles += 1;
  }
}

console.log(
  `fix-esm-extensions: scanned ${relative(process.cwd(), targetDir) || "."} (${changedFiles} file(s) updated)`
);
