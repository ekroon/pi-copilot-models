# Release checklist

The initial candidate is **0.1.0**. The version is reserved locally; no release,
Git tag, registry publication, or repository-visibility change is performed by
these checks.

## Requirements

- Node.js 22.19.0 or newer (use a supported Node.js LTS release).
- Pi 0.84.4 or newer. Development and CI use the locked Pi 1.3.0 toolchain;
  CI runs on Node.js 22 and 24. Older hosts are not part of ongoing CI coverage.
  Prefer current Pi releases for upstream security fixes.
- A clean checkout and the lockfile committed with the release.

Pi supplies the `@earendil-works/*` host packages. They remain wildcard peers as
required by Pi's package-loading contract, not bundled runtime dependencies.
Only the development versions are pinned here. This package ships TypeScript
source, which Pi loads with its extension loader; it is not a plain Node.js
library with a compiled entry point.

## Automated checks

```bash
npm ci
npm run check
npm run check:package
npm audit --audit-level=moderate
npm pack --dry-run
```

`npm pack` runs typechecking and tests through `prepack`. `check:package` packs
with lifecycle scripts disabled to avoid recursion, verifies the shipped file
allowlist, extracts into a temporary directory without `node_modules`, and
loads the extension through Pi's real resource loader. It requires `tar` (as
available on macOS and the Linux CI runner). Neither check needs credentials.
The CLI regression uses synthetic credentials, mocked catalog responses, and a
socket-level network guard; it sends no inference request. To check another
installed Pi CLI, set `PI_TEST_CLI` to its absolute JavaScript entry point when
running `npx tsx --test test/cli-startup.test.ts`.

Review the tarball contents and all Git-tracked files for credentials, endpoint
captures, local paths, and accidental files. The package file allowlist excludes
tests, scripts, plans, todos, CI configuration, and `node_modules`; a public Git
repository still exposes its tracked files and history.

## Manual authenticated smoke test

Automated tests cannot certify the current Copilot service or an individual
account's enabled models. Before tagging:

1. Use an isolated Pi agent directory and authenticate with `/login github-copilot`.
2. Load the candidate checkout with `pi -e /absolute/path/to/pi-copilot-models`.
3. Run `/copilot-models-refresh`, verify `/model` lists the account's models,
   and send a short prompt with a known model.
4. Start a **new** process with `--model github-copilot/<exact-id> --thinking high`.
   Verify the thinking indicator before sending the first prompt. Also test
   `--model github-copilot/<exact-id>:high` and an explicit `--thinking off`.
5. If the catalog advertises context variants, select one and confirm the
   footer, `/session`, and session restore retain it. Do not infer a server-side
   tier selector from the local context window alone.
6. Confirm final request costs agree with returned `copilot_usage` when present.
   Do not publish raw responses, authorization headers, or account data.
7. Restart to exercise the cache; verify a refresh and model switch still work.
   Test without the extension to confirm Pi's built-in provider remains usable.

If the CLI thinking indicator still differs from `/thinking`, capture the
exact invocation, `pi --version`, model ID, startup warnings, and whether the
cache existed. Share no tokens, prompts, or raw network payloads. A passing
mocked CLI test is not evidence that every installed host/model combination
works.

## Recorded live thinking check

A live check on **2026-10-16**, using installed **Pi 1.2.0** with
`github-copilot/gpt-6.1-sol`, verified the candidate's startup level and outgoing
request effort for `--thinking high`, the `:high` suffix, and explicit
`--thinking off` precedence. All three minimal inference requests completed
successfully; their combined displayed cost was USD **0.003656**.

The separately installed Git copy at `ff1d009` reproduced the reset from `high`
to the configured `low` default in a startup-only control. Its extension lacks
the candidate's thinking-restoration change. Updating or explicitly loading the
candidate is required; local edits do not alter a separately installed package.
Sanitized observations are in
[the live thinking smoke record](evidence/release-thinking-smoke.json).
This closes the reported thinking regression for the tested host/account/model;
the broader context-variant and restore checklist above still applies.

## Public release (explicit maintainer action)

1. Confirm repository visibility and review Git history before making it public.
2. Resolve any outstanding authenticated smoke-test failures.
3. Finalize `CHANGELOG.md` with the release date and ensure its version matches
   `package.json` and `package-lock.json`.
4. Merge with green CI, then create and push `v0.1.0` and a GitHub release.
5. Verify installation from the tag in an isolated Pi directory:

   ```bash
   pi install git:github.com/ekroon/pi-copilot-models@v0.1.0
   ```

Git installation is the documented distribution path; npm publication is
optional and is **not** required for this release. Before publishing to npm,
confirm ownership/availability of the package name and the intended registry
account, inspect the actual tarball, and explicitly authorize publication.
