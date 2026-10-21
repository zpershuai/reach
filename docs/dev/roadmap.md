# Roadmap

Items here are **not implemented**. Each one starts as its own OpenSpec change once there is evidence to justify it; none of them is a release commitment. Shipped behavior is described in the README and `docs/`.

## P2: needs evidence before design

| Item | Why it waits | Evidence required before starting |
| --- | --- | --- |
| Performance baseline | No measured numbers exist yet, so no latency or throughput figures are published | A fixed, reproducible load profile (file sizes, request mix, concurrency, network RTT), hardware and versions recorded, repeated runs with variance |
| Signed releases | Releases are verified with SHA-256 over HTTPS from a write-protected release repository; that does not stop an attacker who can replace both an asset and its checksum | A chosen signing scheme, key custody and rotation plan, and installer/updater verification that fails closed |
| SBOM and build provenance | Third-party notices are shipped, but there is no machine-readable SBOM or provenance attestation | A generator verified against the actual Cargo.lock/npm lockfiles and image layers; attestation verified by the installers |
| Feedback-driven features | Several sessions per Engine, more prebuilt targets (Linux arm64, other OpenWrt targets), optional human approval for mutations | Real user reports or use cases describing the need |

## Community and maintenance evidence

Statements about adoption, users or maintenance activity are only made from verifiable, dated sources (public repository history, release downloads, issue activity). Nothing in this repository claims that the source is already public or that any program application has been submitted.
