# Spec Delta

## Purpose

Keeps Reach's user-facing documentation available in both English and Simplified Chinese under one predictable naming and linking convention.

## ADDED Requirements

### Requirement: Bilingual file convention
Every user-facing document SHALL exist as an English file `<name>.md` and a Simplified Chinese file `<name>_cn.md` in the same directory. User-facing documents are the repository README, the top-level `docs/*.md` guides and every guide under `docs/deploy/`.

#### Scenario: Deployment guide pair
- **WHEN** a reader lists `docs/deploy/`
- **THEN** each guide such as `console.md` has a sibling `console_cn.md`, and the `.md` file is in English

### Requirement: Language switch line
Each file in a bilingual pair SHALL start, directly below its title, with a language switch line linking to its counterpart, in the README's format: `English | [简体中文](<name>_cn.md)` in the English file and `[English](<name>.md) | 简体中文` in the Chinese file.

#### Scenario: Switch from a Chinese guide
- **WHEN** a reader opens `docs/deploy/engine_cn.md`
- **THEN** the line below the title links to `engine.md`

### Requirement: Same-language cross links
Links between user-facing documents SHALL point to the document in the same language, including any `#anchor`. Every relative link and anchor in a user-facing document MUST resolve.

#### Scenario: Chinese README links
- **WHEN** a reader follows the Engine deployment link in `README_cn.md`
- **THEN** it opens `docs/deploy/engine_cn.md`

#### Scenario: Translated anchor
- **WHEN** `operations_cn.md` links to a section of `first-run_cn.md`
- **THEN** the link uses the Chinese heading's anchor, and that heading exists

### Requirement: Content parity
The two files of a pair SHALL describe the same procedures, commands, configuration keys, versions and warnings. Executable command structure, configuration keys, environment variable names and file paths MUST be identical in both languages. The pair MUST NOT be labeled as being in the other language.

#### Scenario: First-run guide in Chinese
- **WHEN** a reader follows `first-run_cn.md`
- **THEN** it has the same numbered steps and commands as `first-run.md`, and no "（英文）" label remains in any Chinese index that links to it

### Requirement: Code example localization
Comments, explanatory script messages, descriptive placeholders and diagram labels MUST be translated in both languages, including inside code blocks. Identifier-style placeholders such as `<delegated-client-token>` and `<controller-token>` MAY remain unchanged; surrounding prose MUST explain what value to substitute.

#### Scenario: English code examples and diagrams
- **WHEN** a reader opens an English guide containing a code block or Mermaid diagram
- **THEN** comments, explanatory messages, credential placeholders and diagram labels are in English, while executable command structure, keys and paths match the Chinese guide

#### Scenario: Identifier-style credential placeholders
- **WHEN** a guide uses an identifier-style placeholder such as `<delegated-client-token>`
- **THEN** both languages may retain that placeholder and explain the credential to supply in their own prose

### Requirement: Developer material stays single-language
Developer-only material SHALL remain English-only and MUST NOT be required to have a `_cn.md` counterpart. That covers `docs/dev/`, `docs/reference/`, package READMEs, `CONTRIBUTING.md` and `SECURITY.md`.

#### Scenario: Protocol reference
- **WHEN** a reader opens `docs/reference/protocol.md`
- **THEN** it is in English and no `protocol_cn.md` is expected
