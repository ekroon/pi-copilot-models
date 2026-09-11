# pi-copilot-models

A pi extension that replaces GitHub Copilot's release-time model list with the
account-specific catalog returned by Copilot's `GET /models` endpoint.

This covers rollout gaps where Copilot exposes a model before it appears in
pi's bundled catalog. For example, the endpoint can return
`gpt-5.6-sol-fast` while stock pi only knows `gpt-5.6-sol`.

## How it works

- Reuses pi's built-in GitHub Copilot OAuth, endpoint resolution, and streaming.
- Fetches the catalog with the current, automatically refreshed Copilot token.
- Includes only model-picker entries that are not disabled and support tools.
- Reuses exact built-in metadata when available.
- For a new variant such as `*-fast`, clones the nearest built-in model's API
  and compatibility metadata, then applies limits/capabilities from the server.
- Persists the last successful catalog in pi's agent directory for synchronous
  startup, keyed to a one-way fingerprint of the Copilot account credential.
- Supports Individual, Business, Enterprise, and GHES-derived endpoints.

The extension does **not** read credentials from GitHub Copilot CLI files and
does not invoke `copilot`. Authentication remains owned by pi.

For synchronous startup caching, the default extension supports credentials
stored directly in pi's `auth.json` and `COPILOT_GITHUB_TOKEN`. A
command-backed `apiKey` in `models.json` is resolved asynchronously by pi and
therefore cannot seed this extension's startup cache; the live catalog still
loads during the normal refresh.

## Install

Install directly from GitHub—publishing to npm is not required:

```bash
pi install git:github.com/ekroon/pi-copilot-models
```

Pi clones the repository, installs its dependencies, and records it in your
user settings. To update it later:

```bash
pi update --extensions
```

For reproducible installs, tag a release and pin it:

```bash
pi install git:github.com/ekroon/pi-copilot-models@v0.1.0
```

Pinned refs remain pinned during updates. Install a different ref explicitly to
move to a newer release.

To try the GitHub repository for one run without installing it:

```bash
pi -e git:github.com/ekroon/pi-copilot-models
```

A local checkout also works:

```bash
pi install /absolute/path/to/pi-copilot-models
# Or, for one run only:
pi -e .
```

Authenticate if needed:

```text
/login github-copilot
```

Opening `/model` refreshes dynamic catalogs. You can force a refresh with:

```text
/copilot-models-refresh
```

For non-interactive verification:

```bash
pi -e . --list-models github-copilot
```

## Why a plugin is needed

Pi's built-in Copilot provider already asks the server which bundled model IDs
are enabled for an account. However, filtering a static bundled catalog cannot
create an entry for an ID that pi does not know yet. This extension turns that
server response into actual pi model definitions.

## Metadata caveat

The Copilot model response contains capabilities and token limits, but not all
of pi's transport compatibility metadata. New aliases and variants therefore
inherit metadata from the closest known model. Completely new model families
use conservative API heuristics and zero cost. A newly discovered family may
need an extension update if GitHub routes it through an unexpected API.

## SDK usage

Pi's extension factory API does not expose the SDK session's `agentDir` or
credential. SDK hosts using custom paths or in-memory credentials should create
the extension with those values explicitly:

```ts
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createDynamicCopilotModels } from "./extensions/dynamic-copilot-models.js";

const cwd = process.cwd();
const agentDir = getAgentDir(); // Or another absolute, already-resolved SDK path.
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [
    createDynamicCopilotModels({ agentDir, credential: copilotCredential }),
  ],
});
```

The credential is used only to derive a one-way cache fingerprint; it is not
written to the catalog cache. Omit `credential` when the credential is stored
directly in `<agentDir>/auth.json`. `createDynamicCopilotModels` requires an
explicit SDK `agentDir` to be absolute and already normalized, matching the
resolved value passed to pi.

## Development

```bash
npm install
npm test
npm run typecheck
```
