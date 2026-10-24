#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "README.md",
  "README_cn.md",
  ...["docs", "docs/deploy"].flatMap((dir) =>
    readdirSync(resolve(root, dir))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `${dir}/${name}`),
  ),
];
const userDocs = new Set(files.map((file) => resolve(root, file)));
const findings = new Set();
const report = (file, message) => findings.add(`${file}: ${message}`);
const withoutCode = (text) =>
  text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
function anchors(text) {
  const counts = new Map();
  const result = new Set();
  for (const match of withoutCode(text).matchAll(
    /^#{1,6}\s+(.+?)\s*#*\s*$/gm,
  )) {
    const slug = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    let unique = slug;
    let count = counts.get(slug) ?? 0;
    while (result.has(unique)) unique = `${slug}-${++count}`;
    counts.set(slug, count);
    result.add(unique);
  }
  return result;
}
for (const file of files) {
  const path = resolve(root, file);
  const text = readFileSync(path, "utf8");
  const chinese = file.endsWith("_cn.md");
  for (const block of text.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\s*$/gm)) {
    if (!chinese) {
      if (/\p{Script=Han}/u.test(block[2]))
        report(file, "untranslated Chinese text in code block or diagram");
      continue;
    }
    const startLine = text.slice(0, block.index).split("\n").length;
    for (const [index, line] of block[2].split("\n").entries()) {
      // Require whitespace before inline markers to skip URLs and fragments.
      const comment = /(?:^|\s)(?:#|\/\/)\s+(.+)/.exec(line)?.[1].trim();
      const words = comment?.match(/\b[A-Za-z]+(?:['’-][A-Za-z]+)*\b/g) ?? [];
      if (comment && /^[\x20-\x7e\t]+$/.test(comment) && words.length > 1)
        report(`${file}:${startLine + index + 1}`, "untranslated English comment in Chinese code block");
    }
  }
  const sibling = basename(file).replace(
    /(?:_cn)?\.md$/,
    chinese ? ".md" : "_cn.md",
  );
  if (!existsSync(resolve(dirname(path), sibling)))
    report(file, `missing pair ${sibling}`);
  const line = chinese
    ? `[English](${sibling}) | 简体中文`
    : `English | [简体中文](${sibling})`;
  if (
    !new RegExp(
      `^# [^\\n]+\\n\\s*${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\n|$)`,
    ).test(text)
  )
    report(file, "missing language switch directly below title");
  for (const match of withoutCode(text).matchAll(
    /!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    let target, hash;
    try {
      const [name, fragment] = href.split("#");
      target = resolve(
        name.startsWith("/") ? root : dirname(path),
        decodeURIComponent(name || basename(path)).replace(/^\//, ""),
      );
      hash = fragment === undefined ? undefined : decodeURIComponent(fragment);
    } catch {
      report(file, `invalid link ${href}`);
      continue;
    }
    if (!existsSync(target)) {
      report(file, `missing link ${href}`);
      continue;
    }
    if (
      hash &&
      extname(target) === ".md" &&
      !anchors(readFileSync(target, "utf8")).has(hash)
    )
      report(file, `missing anchor ${href}`);
    if (
      userDocs.has(target) &&
      target !== resolve(dirname(path), sibling) &&
      target.endsWith("_cn.md") !== chinese
    )
      report(file, `cross-language link ${href}`);
  }
}
for (const finding of findings) console.error(finding);
console.log(
  `${files.length} user-facing documents checked; ${findings.size} findings.`,
);
process.exitCode = findings.size ? 1 : 0;
