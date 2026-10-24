import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function check(english = "", chinese = "") {
  const root = mkdtempSync(join(tmpdir(), "reach-docs-i18n-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "docs/deploy"), { recursive: true });
    copyFileSync(new URL("./check-docs-i18n.mjs", import.meta.url), join(root, "scripts/check-docs-i18n.mjs"));
    writeFileSync(join(root, "README.md"), `# Guide\n\nEnglish | [简体中文](README_cn.md)\n\n${english}`);
    writeFileSync(join(root, "README_cn.md"), `# 指南\n\n[English](README.md) | 简体中文\n\n${chinese}`);
    return spawnSync(process.execPath, [join(root, "scripts/check-docs-i18n.mjs")], { encoding: "utf8" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("English guides reject Chinese code-block comments and diagram labels", () => {
  for (const code of ["# 粘贴令牌", "flowchart LR\n A[设备工作区]"]) {
    const result = check(`\`\`\`\n${code}\n\`\`\``);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /untranslated Chinese text/);
  }
});

test("Chinese guides reject full-line and inline English comments", () => {
  for (const code of [
    "# paste the token, press Enter, then Ctrl-D",
    "ls workspaces/docs   # your files are still here",
    "// check the response status",
    "run(); // check the response status",
  ]) {
    const result = check("", `\`\`\`\n${code}\n\`\`\``);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README_cn\.md:6: untranslated English comment/);
  }
});

test("commands, URLs, shebangs and identifier placeholders do not count as untranslated comments", () => {
  const result = check("", [
    "```sh",
    "#!/usr/bin/env bash",
    "curl https://example.com/path#section",
    "TOKEN=<delegated-client-token>",
    "# REACH_ENGINE_TOKEN",
    "# 粘贴 Engine 令牌后按 Enter",
    "run(); // 检查 HTTP 状态码",
    "```",
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
});
