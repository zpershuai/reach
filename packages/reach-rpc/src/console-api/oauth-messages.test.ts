import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLang } from "./oauth-messages.js";

test("OAuth language respects supported cookies and weighted supported header prefixes", () => {
  for (const tag of ["zh-TW", "zh-Hans-CN", "zh-CN,zh;q=0.9"]) assert.equal(resolveLang({ headers: { "accept-language": tag } }), "zh-CN");
  for (const header of ["*", "zh;q=bad", "zh;q=1.2", "zh;q=0", "zh;q=-1", "fr,de", "zh;q=0.0000", "zh;q=0.5;bad"]) assert.equal(resolveLang({ headers: { "accept-language": header } }), "en");
  assert.equal(resolveLang({ headers: { "accept-language": "en;q=0.5,zh;q=0.9" } }), "zh-CN");
  assert.equal(resolveLang({ headers: { cookie: "reach_lang=en", "accept-language": "zh-CN" } }), "en");
  assert.equal(resolveLang({ headers: { cookie: "reach_lang=<script>", "accept-language": "zh-CN" } }), "zh-CN");
  assert.equal(resolveLang({ headers: { cookie: "reach_lang=zh-CN", "accept-language": "en" } }), "zh-CN");
});

test("trims language tags before applying quality preferences", () => {
  assert.equal(resolveLang({ headers: { "accept-language": "en ;q=0.9,zh;q=0.8" } }), "en");
  assert.equal(resolveLang({ headers: { "accept-language": "zh-CN ;q=0.9,en;q=0.8" } }), "zh-CN");
});
