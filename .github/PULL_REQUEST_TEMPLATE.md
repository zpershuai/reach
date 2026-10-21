## What and why

<!-- What does this change, and which issue or OpenSpec change does it implement? -->

## Verification

- [ ] `bash scripts/verify.sh` passes locally (state the OS)
- [ ] Packaging changes: `bash scripts/verify-packaging.sh` on Linux x86_64, or CI
- [ ] New behavior has tests, including the denial or failure path where it matters

## Checklist

- [ ] Behavior changes have an OpenSpec change under `openspec/changes/`
- [ ] Docs updated (README, `docs/`) where behavior or configuration changed
- [ ] No real hostnames, IP addresses, tokens, inventories or reports; examples use `example.com`, documentation IPs and placeholder IDs
- [ ] Security impact considered: who can read, write or execute what after this change?
