# Proposal

## Why

Reach's owners include both English and Chinese speakers, but the product only speaks one language per surface. The Gateway console and the OAuth approval page are English-only. Most deployment guides under `docs/deploy/` are Chinese-only, while `first-run.md` is English-only. Only the README has both languages. Adding Simplified Chinese and English now, while the console is still small (about 7k lines), keeps the cost of extracting strings low. It also sets up an i18n structure that can take more languages later.

## What Changes

- The Gateway console gains an i18n layer built on `i18next`, with complete `en` and `zh-CN` message catalogs. Every user-visible string in the console moves into the catalogs. That includes navigation, views, dialogs, the wizard, empty states, ARIA labels, SVG `<title>`s and error messages.
- On first visit the console picks its language from the browser (`zh*` → `zh-CN`, otherwise `en`). The owner can switch languages from the sign-in/setup screen, the main navigation and Settings. The choice is saved in browser-local storage, applies immediately and never asks for re-authentication.
- Dates, times, relative times ("12 s ago" / "12 秒前") and counts follow the active locale. `<html lang>` and the document title follow it too.
- Console API errors the owner sees are shown in the active language, based on stable error codes. The Gateway adds codes to the console errors that lack them, such as invalid credentials and invalid request. Unknown errors still show the Gateway's own text.
- The Gateway-rendered OAuth approval page (`/oauth/authorize`) is served in `zh-CN` or `en`. The language comes from a non-secret console language cookie when one is set, otherwise from `Accept-Language`. The page's security properties and form behavior do not change.
- User-facing documentation becomes available in both languages, following the README convention: English in `<name>.md`, Simplified Chinese in `<name>_cn.md`, and a language switch line at the top of each. The Chinese-only `docs/deploy/*.md` guides move to `_cn.md` and get English counterparts. `first-run.md` gets a Chinese counterpart. `README_cn.md` links to the Chinese guides. Developer-only material (`docs/dev/`, `docs/reference/protocol.md`, package READMEs) stays English.
- Code identifiers, protocol values, log lines, CLI output and Engine/MCP tool text do not change.

## Capabilities

### New Capabilities
- `console-localization`: language selection, persistence, catalog completeness, locale-aware formatting and localized errors for the Gateway console and the Gateway-rendered OAuth approval page.
- `documentation-localization`: the bilingual convention, coverage and cross-linking rules for user-facing documentation.

### Modified Capabilities
<!-- None. Existing gateway-console and mcp-oauth requirements keep their behavior; examples written in English remain valid in the `en` locale. -->

## Impact

- **Code**: `packages/gateway-console/src/**` (string extraction, a new `i18n/` module, language switchers, locale-aware `formatAgo`/`formatTime`), `packages/reach-rpc/src/console-api/oauth.ts` (localized consent page), `packages/reach-rpc/src/console-api/auth.ts`, `server.ts` and `http.ts` (error codes).
- **Dependencies**: adds `i18next` as a console dev dependency, bundled locally, so no runtime fetch and no CSP change. `react-i18next` is not adopted; see design.md.
- **Tests**: the existing console tests keep running in `en`. New tests cover catalog key parity, language detection and switching, `zh-CN` rendering of every view, localized errors and the localized consent page.
- **Docs**: about 20 guides under `docs/` are renamed or added, and `README.md`/`README_cn.md` links are updated.
- **Compatibility**: no breaking API change, protocol change or storage-schema change. The Gateway's console error responses gain a `code` field and snapshots gain additive `warningDetails` metadata. Existing English error text and warning strings remain available to older consoles.
