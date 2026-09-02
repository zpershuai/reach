## Context

See proposal.md for motivation. The repository has no existing application packages, so Round 1 establishes a small Rust crate and a TypeScript package as the authoritative DTO implementations. The contract must remain transport-independent and avoid JSON Schema duplication.

## Goals / Non-Goals

**Goals:**

- Express one camelCase wire contract in Rust Serde and TypeScript Zod.
- Default `fs.read` line parameters during parsing and demonstrate equivalent fixture round-trips.
- Make protocol validation and `INVALID_PARAMS` classification explicit.

**Non-Goals:**

- Implement filesystem access, network transport, authentication decisions, heartbeat, WSS, or later protocol rounds.
- Produce a JSON Schema artifact or calculate revisions in the DTO layer.

## Decisions

### One request-focused envelope model

Round 1 models a request envelope with the `fs.read` parameter DTO and independently models the corresponding result DTO. This proves the contract boundary without inventing response envelope behavior. The alternative of a generic JSON value `params` would not validate `fs.read` constraints.

### Native validation libraries

Rust uses Serde custom deserialization/serialization attributes and TypeScript uses Zod schemas. Both discard unknown fields and normalize omitted line parameters. A shared JSON Schema is rejected because it would become a third, competing contract source.

### Numeric limits

`startLine` is positive and `maxLines` is limited to 10,000 to give the stated range-validation rule a bounded, testable interpretation. The alternative of unbounded machine integers would not provide a portable resource limit.

### Fixture as the parity boundary

The fixture holds an unknown field and omits defaultable fields. Each language round-trips its own parse/serialize path and the validation script compares the normalized JSON results. The alternative of testing only independent unit expectations would not prove the shared fixture stays compatible.

## Risks / Trade-offs

- [Independent native DTO implementations can drift] → The common fixture and one validator compare their normalized output on every run.
- [No filesystem operation exists yet] → The result DTO documents revision semantics while keeping operational reads out of scope.
- [The 10,000-line cap may need revision] → Future protocol rounds can make it configurable through a compatible spec change.

## Migration Plan

1. Add the standalone Rust and TypeScript contract packages and canonical fixture.
2. Run the fixture validator locally before consumers adopt the DTOs.
3. Roll back by reverting the package commit; no existing wire consumer or persisted data is changed.
