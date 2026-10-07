# Public repository conventions

- Keep deployment documentation, scripts and examples independent of any real deployment. Use reserved example domains, documentation IP addresses, generic device IDs and configurable SSH targets, paths and service labels.
- Store real hostnames, accounts, network topology, credentials, deployment inventories, verification reports and backup locations only in ignored `.reach/` files or outside the repository.
- Do not copy private deployment details into public docs, tests, comments or release notes. Document reusable installation and verification procedures instead.
- Preserve existing installations when making defaults generic; do not modify running services as part of documentation cleanup.
