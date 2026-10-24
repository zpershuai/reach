import { expect, it } from "vitest";
import { en } from "./en";
import { zhCN } from "./zh-CN";

function leaves(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === "string"
        ? [[path, child]]
        : Object.entries(leaves(child, path));
    }),
  );
}
it("keeps complete, nonempty translated catalogs with explicit product-name exceptions", () => {
  const english = leaves(en);
  const chinese = leaves(zhCN);
  const unchanged = new Set([
    "glyph.linux",
    "glyph.macOS",
    "glyph.openwrt",
    "glyph.docker",
  ]);
  expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  for (const key of Object.keys(english)) {
    expect(chinese[key].trim(), key).not.toBe("");
    expect(english[key].trim(), key).not.toBe("");
    if (!unchanged.has(key)) expect(chinese[key], key).not.toBe(english[key]);
  }
});
