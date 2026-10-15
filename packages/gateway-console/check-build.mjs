import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const output = fileURLToPath(
  new URL("../reach-rpc/dist/console/", import.meta.url),
);
const origin = "https://gateway.example.com";
function resource(reference, parent, dataAllowed = true) {
  if (reference.startsWith("data:")) {
    assert.ok(dataAllowed, `Inlined data URL blocked by the console CSP: ${reference.slice(0, 40)}`);
    return;
  }
  const url = new URL(reference, parent);
  assert.equal(url.origin, origin, `External resource: ${reference}`);
  assert.ok(
    url.pathname.startsWith("/console/"),
    `Outside console: ${reference}`,
  );
  const path = resolve(
    output,
    decodeURIComponent(url.pathname.slice("/console/".length)),
  );
  assert.ok(path.startsWith(output), `Outside output: ${reference}`);
  assert.ok(existsSync(path), `Missing resource: ${reference}`);
}
const document = new JSDOM(readFileSync(resolve(output, "index.html"), "utf8"))
  .window.document;
for (const element of document.querySelectorAll(
  "script[src], link[href], img[src], source[src]",
)) {
  resource(
    element.getAttribute("src") ?? element.getAttribute("href"),
    `${origin}/console/`,
  );
}
const assets = readdirSync(resolve(output, "assets"));
assert.ok(
  assets.some((name) => /-[\w-]+\.js$/.test(name)),
  "Hashed JavaScript missing",
);
assert.ok(
  assets.some((name) => /-[\w-]+\.css$/.test(name)),
  "Hashed stylesheet missing",
);
for (const name of assets.filter((name) => name.endsWith(".css"))) {
  const css = readFileSync(resolve(output, "assets", name), "utf8");
  for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
    resource(match[1], `${origin}/console/assets/${name}`, false);
  }
  assert.ok(!/@import\s*["']/i.test(css), "Unbundled stylesheet import");
}
console.log(
  "Console HTML, scripts, styles and fonts resolve locally; inert documentation URLs are permitted.",
);
