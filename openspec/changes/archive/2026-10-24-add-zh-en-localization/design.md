# Design

## Context

- The console (`packages/gateway-console`) is React 19 + Vite + TypeScript 7. It has no router or state library; routing (`router.ts`) and the clock (`clock.ts`) use small `useSyncExternalStore` stores. Strings are hard-coded in about 15 components, for example the `navigation` table in `App.tsx`, `formatAgo` in `ui.tsx` and the SVG `<title>`s in `Topology.tsx`.
- The console's CSP (`script-src 'self'`) forbids runtime fetches from other origins. `check-build.mjs` fails the build on any external resource. All dependencies are dev dependencies bundled by Vite.
- Theme is stored as a Gateway setting (`PATCH /api/console/settings`). The owner chose browser-local storage for the language instead, so it also works before sign-in.
- Console API errors are `ConsoleError(status, message, code?)` in `reach-rpc/src/console-api/auth.ts`. Only `RATE_LIMITED`, `REAUTH_REQUIRED` and `CSRF_REJECTED` have codes; "Invalid credentials", "Invalid request" and others have none.
- The OAuth approval page is an HTML template string in `oauth.ts` (`consent()` and `page()`), with `lang="en"` and English strings. The validation errors are passed in as English literals.
- Existing console tests select elements by English text and accessible name, for example `getByRole("button", { name: "Sign out" })`.
- Docs: `docs/deploy/*.md` is Chinese except `first-run.md` (English). `README.md`/`README_cn.md` use the `_cn` sibling convention with a switch line.

## Goals / Non-Goals

**Goals:**
- A single, typed message catalog per language that the compiler and tests keep in sync.
- Language switching without reloads or flicker, and without adding providers around the existing stores.
- Small bundle impact; no network loading of catalogs.

**Non-Goals:**
- Languages other than `en` and `zh-CN`, right-to-left layout, Traditional Chinese.
- Translating Gateway logs, CLI output, Engine/MCP tool descriptions or protocol error strings.
- Server-side storage of the language preference.
- Machine-translation pipelines or a translation-management service.

## Decisions

### D1. `i18next` core with a thin in-house React binding, not `react-i18next`
Use `i18next` (pinned to `26.4.2`, released 2026-09-03) with resources imported statically. Expose a `useT()` hook built on `useSyncExternalStore`, subscribed to i18next's `languageChanged` event, in the same way as `useRoute`/`useNow`.
- *Why not react-i18next*: only `react-i18next` ≥ 17.1.0 declares TypeScript 7 in its peer range, and every such release is less than two weeks old as of 2026-10-24. The older 17.0.x line declares `typescript: ^5 || ^6`. The binding we need (a hook plus `<Trans>`-free interpolation) is about 30 lines. We can adopt `react-i18next` later without touching the catalogs, because the keys and the i18next instance stay the same.
- *Why not a hand-rolled dictionary*: the owner asked for i18n via i18next. It also gives us plurals (`_one`/`_other`), interpolation with escaping and a fallback language without extra work.
- *Alternatives*: FormatJS/`react-intl` (heavier ICU runtime, different message syntax), Lingui (needs a compile step and macros).

### D2. Catalog layout and typing
- `src/i18n/en.ts` is the source of truth: a nested `as const` object grouped by area (`nav`, `auth`, `overview`, `topology`, `clients`, `devices`, `wizard`, `activity`, `settings`, `skills`, `errors`, `common`).
- `src/i18n/zh-CN.ts` is typed `Messages` (derived from `en`). A missing or extra key is then a `tsc` error, which `npm run build` already runs.
- Module augmentation of i18next's `CustomTypeOptions` types the keys for `t()`.
- Catalogs are TypeScript, not JSON, so they get type checking and stay in the bundle without a JSON loader. Both languages ship in the main chunk: the catalogs are small (an estimated < 25 KB minified for both), and loading one lazily would add a flash of the wrong language.

### D3. Language resolution and persistence
Resolve the language in this order at startup, before the first render:
1. `localStorage["reach.console.lang"]` if it is `en` or `zh-CN`.
2. The first entry of `navigator.languages` matching `zh*` → `zh-CN`, or `en*` → `en`.
3. `en`.

Wrap every storage access in try/catch (blocked storage is a spec scenario). Only an explicit `setLang()` choice writes storage and the cookie; initial browser detection writes neither. Always synchronize `document.documentElement.lang` on initialization and language changes. Set `document.title` from the `app.title` key. Set the non-sensitive cookie `reach_lang=<tag>; Path=/; SameSite=Lax; Max-Age=31536000` so the Gateway-rendered OAuth page can follow the choice. The cookie is set via `document.cookie`; no server endpoint is involved.
- *Why a cookie as well*: the OAuth page is served by the Gateway and cannot read `localStorage`. Without the cookie, an owner who chose English in a Chinese-language browser would get a Chinese approval page. The cookie holds a language tag only (see the spec's non-sensitive cookie requirement), so the "no credentials in browser storage" rule is unaffected.

### D4. Language switcher placement
- A compact `EN / 中` toggle (a button group with `aria-pressed`) in the nav footer next to Sign out. It uses the existing narrow-screen menu, so the "Narrow-screen navigation" requirement keeps holding.
- The same toggle in the corner of `AuthScreen` (setup and sign-in).
- A "Language" field in Settings next to Theme. Like Theme, it applies immediately. Unlike Theme it makes no API call, so it never triggers re-authentication.

Changing the language only re-renders. Component state such as typed passwords, wizard step and filters is kept because no component remounts.

### D5. Locale-aware formatting
Use catalog templates for seconds, minutes and hours in `formatAgo`, preserving deterministic output such as `12 s ago` / `12 秒前` across ICU versions. Use `Intl.DateTimeFormat` for dates and clock times (`hourCycle: "h23"`) and `Intl.NumberFormat` for numbers and bytes. Give these helpers an explicit `lang` argument, supplied by `useT()`, so they stay pure and testable. `never` becomes a catalog key. Cache the topology count formatter until the language changes; do not derive or rewrite a canvas tooltip on every animation frame.

### D6. Error localization
- Assign each RegistryError and ClientAccessError reason a dedicated code; HTTP status alone cannot identify its meaning. Older Gateways without codes retain their server-message fallback. Transport failures use a localized `GATEWAY_UNAVAILABLE` code.
- Add `gateway.warningDetails` with stable `code`, English `message` and optional `params`, retaining the existing `warnings` strings for older consoles. Translate by code; unknown codes and legacy strings stay verbatim, without matching English sentences.
- Add codes to every `ConsoleError` without one and to the JSON errors written directly in `http.ts`/`server.ts`, for example `INVALID_CREDENTIALS`, `SIGN_IN_REQUIRED`, `INVALID_REQUEST`, `PASSWORD_LENGTH`, `ADMIN_EXISTS`, `METHOD_NOT_ALLOWED`, `BODY_TOO_LARGE`, `STORAGE_UNAVAILABLE`, `NOT_FOUND` and `INVALID_LAST_EVENT_ID`. Existing codes are unchanged. The English `error` text stays as it is, for older consoles and for API users.
- In the console, `ApiError` keeps `message` (server text) and `code`. A single `errorText(error, t)` helper returns `t("errors.<code>")` when the key exists, otherwise the server message. The no-body fallback becomes `t("errors.http", { status, statusText })`. Call sites that currently do `error instanceof Error ? error.message : "…"` go through this helper.
- Values such as `retryAfter` are interpolated (`errors.RATE_LIMITED` → "Too many attempts; try again in {{seconds}} s").

### D7. OAuth approval page
Move the consent and page strings into a small server-side catalog `reach-rpc/src/console-api/oauth-messages.ts` (`en` and `zh-CN`, same key-parity typing as D2). i18next is not used on the Gateway: the page has about 20 strings and the Gateway runtime should not gain a dependency.
- Language resolution: `reach_lang` cookie (exact match `en`|`zh-CN`), then a minimal `Accept-Language` q-value parse (first supported prefix), then `en`. The validation errors passed to `consent()` become message keys instead of literals, so a re-render after a failed POST uses the same language.
- Every interpolated value still goes through `escapeHtml`. The cookie value is never interpolated; it only selects a catalog.
- Add `Vary: Accept-Language, Cookie` to the page response (it is already `no-store`).

### D8. Tests stay in English by default
`test-setup.ts` forces `en` before each test and clears the stored language, so existing English selectors keep working. New tests switch to `zh-CN` explicitly. A catalog test checks that:
- the keys are identical (redundant with `tsc`, but it also catches empty strings);
- every `zh-CN` value differs from its `en` value, except an allow-list of terms that stay in English, such as `MCP`, `Gateway`, `Engine` and `TOTP`.

A render test opens every view in `zh-CN` and asserts that none of the known English UI strings from `en.ts` appear.

### D9. Documentation convention
Translate comments and descriptive placeholders in both languages. Identifier-style placeholders such as `<delegated-client-token>` may stay unchanged, with replacement instructions in the surrounding prose. The documentation check detects untranslated Chinese code-block text in English guides and English comment sentences in Chinese guides.
Follow the README convention: English is `<name>.md` and Chinese is `<name>_cn.md`. For the currently Chinese guides, `git mv x.md x_cn.md` and then write a new English `x.md`. That keeps the Chinese file's history and makes English the default name, which matches GitHub's display and the README. Update `README_cn.md` to link to `_cn` guides and drop the "（英文）" labels. Add a small script, `scripts/check-docs-i18n.mjs`, run from `scripts/verify.sh`. It checks that every user-facing doc has its pair and its switch line, and that every relative link and anchor resolves. Anchors are computed with GitHub's slug rules, including CJK headings.
- *Alternative*: a `docs/zh-CN/` mirror tree. It is cleaner for large doc sets, but it breaks the established README convention and every existing relative link.

## Risks / Trade-offs

- [A string is missed during extraction] → The `zh-CN` render test fails when it finds known English UI strings. Reviewers grep JSX text nodes and the `aria-label`/`title`/`placeholder` attributes. A one-off audit task lists the remaining literals.
- [Chinese text overflows narrow layouts (nav, table headers, topology labels)] → Chinese is usually shorter, but labels like 正在重新连接 can still be wide. Check at 390 px and in the Topology lanes in both languages and both themes.
- [Fonts lack CJK glyphs] → Geist and Bricolage have no CJK coverage, so the browser falls back to system fonts. Add an explicit CJK fallback stack (`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`) after the Latin faces. Do not bundle a CJK webfont (several MB).
- [Translated docs drift from each other] → The parity requirement and the check script cover structure (pairs, switch lines, links) but not wording. `CONTRIBUTING.md` gains a rule: a change to one language updates the other in the same PR.
- [Translation volume (about 3,000 lines of Chinese guides to render in English)] → Translate guide by guide, each as its own task, and keep executable command structure, configuration keys, environment variable names and paths identical, while translating comments, explanatory script messages, descriptive placeholders and diagram labels.
- [`Accept-Language` parsing edge cases] → Keep it minimal and covered by unit tests (`zh-TW`, `zh-Hans-CN`, `*`, malformed q-values). Unknown or malformed input → `en`.

## Migration Plan

- No data migration. The console and Gateway ship together in the Gateway release. Older Gateways without codes still work with a new console through the server-message fallback.
- Doc renames keep the old English-named path pointing at English content. External links to a `docs/deploy/x.md` that used to be Chinese now land on English, with a switch link to Chinese one click away. Note this in the release notes.
- Rollback: revert the release. The language cookie and localStorage key are inert to older builds.
