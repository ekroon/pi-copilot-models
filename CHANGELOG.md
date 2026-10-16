# Changelog

## 0.1.0 — Unreleased

Initial public release candidate.

### Features

- Discover account-enabled GitHub Copilot models using Pi's own authentication
  and streaming adapters, including models missing from Pi's bundled catalog.
- Publish advertised default and long-context variants with explicit canonical
  routing, validated pricing, and model-object-bound routes across refreshes.
- Restore credential-bound catalogs and account endpoints from an atomic cache.
- Use settled Copilot AI-credit usage for final displayed request costs, with
  catalog-derived costs as a fallback.
- Preserve the active thinking level when rebinding the same model after
  startup or manual refresh, including command-line thinking overrides.

### Release hardening

- Isolate concurrent cache writes and clean up temporary files on failure.
- Bound usage-observer line/event retention as well as JSON fallback retention.
- Resolve unexpected stream failures as normal error messages and support
  providers that finish with `end(message)`.
- Require a nonzero price anchor before trusting endpoint price units.
- Report discovery failures by HTTP status without reading or logging raw
  server error bodies.
- Add a real CLI thinking regression test, extracted-package loading smoke
  test, release checks, and CI compatibility coverage.
- Update the development toolchain to Pi 1.3.0 and declare the Node.js minimum.

### Known limitations

- New model families inherit conservative transport metadata; a previously
  unseen API may require an extension update.
- Dynamic IDs require a matching startup cache to resolve before session start.
  Run `/copilot-models-refresh` once before using a new ID on the command line.
- Context tiers adjust local capability accounting. The repository does not
  contain paired transport captures proving a server-side tier selector; no
  speculative tier field or header is sent. See
  [the evidence boundary](docs/context-tier-protocol.md).
- Command-backed API keys cannot seed the synchronous startup cache.
