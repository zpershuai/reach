# Contributing to Reach

Thanks for helping. Bug reports, documentation fixes (including English translations of the deployment guides), and code changes are all welcome.

## Repository layout

| Path | Contents |
| --- | --- |
| `crates/reach-rpc/` | Rust Engine: runtime, session transport, tool dispatch, workspace filesystem, process supervision |
| `packages/reach-rpc/` | TypeScript Gateway: control API, grants, session forwarding, HTTP `/mcp`, console API, OAuth |
| `packages/gateway-console/` | Web console UI served at `/console/` |
| `packages/grok-bot-mcp-connector/` | Standalone stdio MCP Connector. The directory name is historical; it works with any stdio MCP client |
| `grok-bot-plugin/` | Remote HTTP plugin template for Grok Bot |
| `fixtures/` | Shared protocol fixtures used by both the Rust and TypeScript tests |
| `scripts/` | Installers, packaging, release helpers and verification scripts |
| `deploy/` | Docker Compose, Dockerfiles and updater units |
| `docs/deploy/` | Deployment guides (currently in Chinese) |
| `docs/reference/` | Protocol and runtime reference |
| `docs/dev/` | Maintainer notes: past code reviews and the publishing checklist |
| `openspec/` | Specifications (`specs/`) and the history of changes (`changes/`) |
| `.claude/`, `.agents/` | OpenSpec workflow skills for AI coding assistants; you can ignore them |

## Development workflow

Behavior changes start as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change under `openspec/changes/`. The change contains a proposal, delta specs and tasks. Archive the change into `openspec/specs/` once it is implemented. Small fixes that do not change specified behavior can go straight to a pull request.

## Verify before sending a pull request

Requires Git, Node.js 24 with npm, a Rust toolchain and Python 3. CI uses the exact versions in [`scripts/toolchain.json`](scripts/toolchain.json); use them if a failure looks toolchain-related. No deployment credentials, secrets or network services are needed: a fresh fork builds and tests with only the commands below.

```bash
npm ci --ignore-scripts
npm --prefix packages/reach-rpc ci --ignore-scripts
bash scripts/verify.sh
```

`verify.sh` runs strict OpenSpec validation, installer tests, `cargo fmt --check`, the Rust and TypeScript test suites (including real Engine integration), the console build, and the MCP distribution smoke test. Packaging checks (`scripts/verify-packaging.sh`) need Docker, `musl-tools` and the Rust musl target; CI runs them on Linux.

For a full local run with authentication, a scoped client and a script, follow [first run](docs/deploy/first-run.md).

## Reporting bugs

Use the issue templates. Issues are public: include component versions, platform, stable error codes and a synthetic reproduction, never tokens, env dumps, private hostnames, file contents or process output. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Keep private deployment details out

This is a public repository; read [AGENTS.md](AGENTS.md). Examples must use reserved domains (`example.com`), documentation IP addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) and placeholder device IDs. Real hostnames, tokens, inventories and verification reports belong in the git-ignored `.reach/` directory. Never commit them, including in tests, comments and release notes.

## Releases

Components are released independently by pushing `engine-vX.Y.Z` or `gateway-vX.Y.Z` tags that match the manifest versions. See [versions](docs/deploy/versions.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

---

### 中文摘要

欢迎提交问题、文档改进（尤其是部署文档的英文翻译）和代码。

- 改变既有行为时，先在 `openspec/changes/` 下创建 OpenSpec 变更。
- 提交前运行 `bash scripts/verify.sh`；不需要任何部署凭证。
- Issue 是公开的：只提供版本、平台、稳定错误码和脱敏重现步骤；漏洞按 SECURITY.md 私下报告。
- 示例里只能使用保留域名和文档 IP；真实主机、token 和部署记录只能放在被 Git 忽略的 `.reach/` 目录。
- 贡献的内容按 Apache-2.0 授权。
