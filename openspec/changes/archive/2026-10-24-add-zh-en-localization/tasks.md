# Tasks

## 1. Console i18n foundation

- [x] 1.1 Add `i18next@26.4.2` (exact pin) to `packages/gateway-console` devDependencies and refresh `package-lock.json`. Verify with `npm --prefix packages/gateway-console ci --ignore-scripts` and `run build`; `check-build.mjs` must still pass with no external resources.
- [x] 1.2 Create `src/i18n/en.ts` (an `as const` source catalog), `src/i18n/zh-CN.ts` (typed `Messages`) and `src/i18n/index.ts`: an i18next instance with static resources, fallback `en`, `CustomTypeOptions` augmentation, and `useT()` built on `useSyncExternalStore` that returns `{ t, lang, setLang }` (design D1/D2). Verify that `tsc --noEmit` fails when a key is removed from `zh-CN.ts`, then restore the key.
- [x] 1.3 Implement language resolution and persistence (`reach.console.lang` in localStorage → `navigator.languages` → `en`). Wrap storage in try/catch. On initialization and change, set `<html lang>` and `document.title`. Persist only explicit language choices to localStorage and the `reach_lang` cookie (`Path=/; SameSite=Lax; Max-Age=31536000`) (design D3). Unit tests cover the spec scenarios Chinese browser, unsupported language, reload keeps choice and storage blocked.
- [x] 1.4 Make `test-setup.ts` force `en`, clear the stored language and clear the cookie before each test. Verify that `npm --prefix packages/gateway-console test` passes unchanged.
- [x] 1.5 Add the CJK fallback font stack to `style.css` after the Latin faces. Verify visually in `npm run dev` that Chinese text renders in the system CJK face and that the Latin text is unchanged.

## 2. Locale-aware formatting

- [x] 2.1 Rewrite `formatAgo`, `formatTime` and `formatBytes` in `ui.tsx` to take `lang` and use catalog templates for relative times and `Intl.DateTimeFormat`/`NumberFormat`. Move `never` into the catalog. Update all call sites (`Devices.tsx`, `Topology.tsx`, `Views.tsx`, `Activity.tsx`) to pass `lang` from `useT()`. Verify that the existing `clock.test.tsx` English assertions still pass, and that new tests cover `12 秒前` and the zh never-seen value.

## 3. String extraction

Each task moves every user-visible literal in its files, including `aria-label`, `title`, `placeholder`, SVG `<title>` and `alt`, into catalog keys with `en` and `zh-CN` values. Each task adds a `zh-CN` render test for its views that asserts the Chinese headings and controls and no leftover English UI strings. The existing English tests must keep passing.

- [x] 3.1 `App.tsx`: navigation labels, loading and Retry text, the `Planned` badge, page titles, Sign out and Add device. Verify with an updated `ui.test.tsx` and a new zh nav test.
- [x] 3.2 `Auth.tsx` (setup, TOTP, recovery codes, sign-in, re-authentication dialog). Verify with zh tests for the setup and sign-in screens and the re-auth dialog.
- [x] 3.3 `Views.tsx` (Overview, Clients, Skills, Settings) and `AccessClients.tsx`. Verify with a zh render test per view and `access-clients.test.tsx` passing.
- [x] 3.4 `Devices.tsx` (device list and add-device wizard, all four steps and platform names) and `Glyph.tsx` labels. Verify with a zh wizard test that walks the steps and with `components.test.tsx` passing.
- [x] 3.5 `Topology.tsx`, `topology/drawers.tsx` and `topology/renderer.ts` (lane labels, stage names, link and status text, drawer fields, aggregated-particle counts with plurals). Verify with `topology.test.tsx` passing and a zh drawer test.
- [x] 3.6 `Activity.tsx` (filters, result labels, exports, empty states), keeping URL filter values as untranslated identifiers. Verify with `activity.test.tsx` passing and a zh test asserting that a reload with filters restores them in Chinese.
- [x] 3.7 `ui.tsx` shared components (`EngineStatus`, `Modal`, copy-button confirmation, `ClientAvatar` fallbacks) and `store.ts` connection-state labels (Live, Reconnecting). Verify with a zh test of the reconnect banner and copy confirmation.
- [x] 3.8 Audit: grep `src/**/*.tsx` for remaining JSX text nodes and string-valued `aria-label`/`title`/`placeholder`. Convert or justify each hit, and add a catalog test asserting key parity, no empty values, and zh ≠ en except the allow-list (design D8). Verify that the audit grep returns only allow-listed identifiers.

## 4. Language switcher

- [x] 4.1 Build a `LanguageToggle` component (`EN / 中` button group with `aria-pressed` and a localized accessible name). Place it in the nav footer, inside the narrow-screen menu, and on `AuthScreen` (design D4). Verify with tests: switching on the sign-in screen keeps the typed password, and at 390 px the toggle is reachable alongside Sign out and Add device.
- [x] 4.2 Add a Language field to Settings that applies immediately with no API call. Verify with a test that stale authentication (more than ten minutes) does not open the re-auth dialog and that no `PATCH /settings` request is made.

## 5. Gateway error codes and console error localization

- [x] 5.1 Add stable codes to every code-less `ConsoleError` and direct JSON error in `reach-rpc/src/console-api/{auth,server,http,sse}.ts` (design D6). Keep existing codes and English `error` text. Verify that `npm --prefix packages/reach-rpc test` passes, with new assertions for `INVALID_CREDENTIALS` and an unchanged `REAUTH_REQUIRED`.
- [x] 5.2 Add `errorText(error, t)` to the console. Route every `error.message` fallback in `App.tsx`, `Auth.tsx`, `Views.tsx`, `Devices.tsx`, `AccessClients.tsx` and `Activity.tsx` through it, and localize the no-body HTTP status message in `api.ts`. Verify that `api.test.ts` covers a known code in zh, an unknown code showing the server text, and a 502 HTML page showing a zh message containing `502`.

## 6. Localized OAuth approval page

- [x] 6.1 Create `reach-rpc/src/console-api/oauth-messages.ts` with typed `en`/`zh-CN` catalogs and a `resolveLang(request)` that checks the `reach_lang` cookie, then a minimal `Accept-Language` parse, then `en` (design D7). Unit-test `zh-TW`, `zh-Hans-CN`, `*`, malformed q-values, a tampered cookie, and the cookie overriding the header.
- [x] 6.2 Refactor `consent()`/`page()` in `oauth.ts` to render from the catalog, set `<html lang>`, pass error keys instead of literals, and add `Vary: Accept-Language, Cookie`. Leave the CSP, referrer policy and form fields unchanged. Verify with `oauth.test.ts` cases for a Chinese GET page, the console cookie forcing English, a wrong code re-rendering in Chinese and still counting toward rate limits, and a `<script>` cookie value that is never echoed.

## 7. Bilingual documentation

For each guide, preserve executable command structure, configuration keys, environment variable names and paths. Translate prose, comments, explanatory script messages, descriptive placeholders and diagram labels, including those inside code blocks. Each file starts with the switch line from the spec, and links point to same-language counterparts with translated anchors.

- [x] 7.1 Add `scripts/check-docs-i18n.mjs` (pair existence, switch lines, relative link and anchor resolution using GitHub slug rules for CJK headings) and wire it into `scripts/verify.sh`. Verify that it currently reports the missing pairs, then passes once group 7 is done.
- [x] 7.2 `git mv` each Chinese-only guide in `docs/deploy/` (all except `first-run.md`) and the top-level `docs/deployment.md`, `docs/deployment-verification.md` and `docs/mcp-install.md` to `<name>_cn.md`. Add switch lines and update their internal links to `_cn` targets. Verify that the check script shows only the missing English files.
- [x] 7.3 Write English `docs/deploy/README.md`, `configuration.md`, `gateway.md` and `console.md`. The console guide documents the language switcher and the OAuth page language rule. Verify that the check script passes for these pairs.
- [x] 7.4 Write English `engine.md`, `linux.md`, `openwrt.md` and `node-runtime.md`. Verify with the check script.
- [x] 7.5 Write English `client-access.md`, `mcp.md` and `processes.md`. Verify with the check script.
- [x] 7.6 Write English `verification.md`, `operations.md`, `troubleshooting.md`, `versions.md` and `deployment-checklist.md`, plus the three top-level `docs/*.md` pointers. Verify with the check script.
- [x] 7.7 Write `docs/deploy/first-run_cn.md` from `first-run.md`, including the console language step. Verify with the check script.
- [x] 7.8 Update `README.md` to link English guides and `README_cn.md` to link `_cn` guides, removing the "（英文）" labels. Add the "update both languages in the same PR" rule to `CONTRIBUTING.md`. Verify that `node scripts/check-docs-i18n.mjs` passes with zero findings.

## 8. Integration verification

- [x] 8.1 Run `npm --prefix packages/gateway-console test`, `npm --prefix packages/gateway-console run build`, `npm --prefix packages/reach-rpc test` and `npm run verify` from the repository root. All must pass.
- [x] 8.2 Follow the manual check in `packages/gateway-console/README.md` against a loopback Gateway in both languages: setup/sign-in, every view, the wizard, the topology drawer, Activity filters, the reconnect banner, light/dark themes, a 390 px viewport and reduced motion. Confirm there is no layout overflow in Chinese and the `<html lang>`/title switch. Start an OAuth authorization from an MCP client with each language selected and confirm the approval page language follows the console choice.
