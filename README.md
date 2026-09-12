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
- Expands advertised `default` and `long_context` billing tiers into ordinary
  pi models with tier-specific context windows and validated complete prices.
- Persists the last successful catalog, resolved account inference URL, and
  explicit variant routes in pi's agent directory for synchronous startup,
  keyed to a one-way fingerprint of the Copilot account credential.
- Reconciles an active provider/model ID to the newly published model object
  after startup or manual refresh, and deliberately falls back if a selected
  variant was removed instead of retaining stale limits, prices, or routing.
- Reports cache-write failures once as non-fatal warnings; the live catalog
  remains usable.
- Uses Copilot's settled per-request `copilot_usage` amount for Pi's displayed
  cost when the response provides it, while retaining catalog-rate calculation
  as a fallback.
- Supports Individual, Business, Enterprise, proxy-derived, and GHES-derived
  endpoints without inheriting a built-in template's account URL.

## Context-tier variants

When `GET /models` advertises a valid default prompt limit, the unsuffixed
canonical model becomes Copilot's default context tier. Every distinct,
verified additional tier becomes a synthetic pi model:

```text
gpt-5.6-sol          GPT-5.6 Sol · 400k
gpt-5.6-sol-1.1M     GPT-5.6 Sol · 1.1M
```

The suffix uses exactly pi's footer notation (`400k`, `1.0M`, `1.1M`, and so
on). The effective window is the advertised prompt limit plus maximum output,
capped by the model's absolute context limit. If default tier metadata is
missing or malformed, the extension preserves the prior one-model behavior;
it does not guess a tier.

Variants use pi's existing `/model`, `Ctrl+L`, model cycling, footer, session
persistence, scoped-model, and compaction behavior. There is no custom context
selector or setting. An exact canonical model setting remains stable and means
the default tier. Switching to a smaller variant does not compact immediately,
but pi checks the new window and safely compacts before the next assistant
response when the conversation exceeds its threshold.

The selected variant controls pi's context accounting and price schedule.
Each variant receives one complete advertised tier schedule; the extension does
not infer threshold billing. Endpoint prices are accepted only after their
cents-per-`batch_size` units are confirmed against a matching built-in model;
otherwise every affected variant retains the complete inherited schedule.

Synthetic IDs are never sent to GitHub. They are rewritten to the canonical
model ID immediately before provider dispatch, without inventing a tier body
field or header. Checked-in CLI schema/runtime excerpts support local tier
capability accounting, but no sanitized raw paired transport captures were
available for this pass. The exact evidence and claim boundary are recorded in
[the protocol evidence](docs/context-tier-protocol.md).

### Scoped model examples

Only the default tier:

```json
{
  "enabledModels": ["github-copilot/gpt-5.6-sol"]
}
```

Only the current larger tier (the generated suffix follows the current
catalog limit):

```json
{
  "enabledModels": ["github-copilot/gpt-5.6-sol-1.1M"]
}
```

Both tiers:

```json
{
  "enabledModels": ["github-copilot/gpt-5.6-sol*"]
}
```

Broad patterns naturally include generated variants; narrow the pattern when
larger variants should not participate in cycling. Models, their resolved
account inference URL, and explicit route metadata share the existing
credential-bound atomic startup cache, so restored sessions and scoped models
resolve synchronously. Older cache versions are normal misses because their
routing, endpoint, and pricing semantics cannot be reconstructed safely.
Finalized Anthropic messages are normalized back to the selected synthetic ID (while retaining the reported
canonical ID as `responseModel`), which preserves the variant and signed
thinking replay across session restore.

## Settled AI-credit costs

Copilot responses may include a `copilot_usage` object with `total_nano_aiu`
and per-category `token_details`. The extension observes this metadata for all
three Copilot transports (Responses, Chat Completions, and Anthropic Messages)
without changing the response bytes delivered to Pi's built-in adapters.

One AI credit is USD $0.01, so the authoritative request total is converted as:

```text
USD = total_nano_aiu / 1,000,000,000 / 100
```

Known `input`, `output`, `cache_read`, and `cache_write` details populate Pi's
cost breakdown. Unknown future categories remain represented in the
server-provided total. Missing or malformed metadata leaves Pi's existing
catalog-derived costs unchanged. The corrected final message follows Pi's
normal persistence, compaction, `/session`, and footer aggregation paths.
Sanitized captures for each transport and a Copilot CLI conversion check are
recorded in [the usage evidence](docs/evidence/copilot-usage-contract.json).

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

The Copilot model response contains capabilities, limits, and billing data,
but not all of pi's transport compatibility metadata. New aliases and variants
therefore inherit metadata from the closest known model. Completely new model
families use conservative API heuristics. They retain zero cost unless the
response's price units have been validated against a known model in the same
catalog. A newly discovered family may need an extension update if GitHub
routes it through an unexpected API.

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
