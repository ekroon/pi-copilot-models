# Dynamic GitHub Copilot models for pi

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
- Persists the last successful account-specific catalog for offline startup.
- Supports Individual, Business, Enterprise, and GHES-derived endpoints.

The extension does **not** read credentials from GitHub Copilot CLI files and
does not invoke `copilot`. Authentication remains owned by pi.

## Install

From a checkout:

```bash
pi install /absolute/path/to/pi-dynamic-model-selector-copilot
```

Or test it without installing:

```bash
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

## Development

```bash
npm install
npm test
npm run typecheck
```
