# Copilot context-tier evidence boundary

This extension does not invent a context-tier request field. This document
records what is reproducible in the repository and, equally importantly, what
is not.

## Checked-in source excerpts

`docs/evidence/copilot-cli-1.0.84-context-evidence.json` contains sanitized,
minimal excerpts from a locally installed Copilot CLI `1.0.84-4`, with the
SHA-256 hashes and relative paths of the source artifacts. The excerpts show:

- the generated schema recognizes exactly `default` and `long_context`;
- the CLI models a tier as session state used to derive effective capability
  overrides for compaction, truncation, token display, and request limits;
- default and long-context `maxPromptTokens` are prompt budgets, with total
  context described as prompt budget plus `max_output_tokens`;
- the runtime's `--context` option accepts `default` and `long_context`.

The excerpts are data structures and exact runtime substrings, not prose
summaries presented as request evidence.

## Request-evidence limit

No sanitized raw paired request captures were available locally in this pass.
Accordingly, the repository does **not** claim that checked-in captures prove
body/header parity for Responses, Chat Completions, and Anthropic Messages, or
that omission/default behavior was observed on each transport.

The extension's narrow transport behavior is independently testable: for all
three ordinary serialized payload shapes, it changes only a synthetic
`model` value to its explicit canonical model ID. It adds no guessed field or
header. This is a conservative implementation choice, not a claim that the
fixtures are captured Copilot traffic.

## Publication and pricing rules

A variant is published only when authenticated catalog data supplies positive
integer prompt limits for both the default tier and a distinct long-context
tier. Effective context is:

```text
min(advertised absolute context, prompt limit + max output)
```

Endpoint prices are accepted only when a model already known to pi confirms
all four converted rates in the same response. Every variant then receives one
complete schedule corresponding to its advertised tier. The implementation
does not synthesize threshold-based `ModelCost.tiers`, because no reproducible
sanitized usage or invoice artifact is checked in to substantiate that billing
behavior. Missing, malformed, unanchored, or unrepresentable schedules retain
coherent inherited prices (or zero for an unknown family).

## Routing and response normalization

Routes are explicit `Map` entries bound immutably to published model objects.
A catalog refresh gives new objects their new routes but does not invalidate an
old object that pi may still have selected after an independent refresh (for
example, opening and cancelling `/model`). This also prevents an alias that
later becomes canonical from inheriting the alias route.

At `before_provider_request`, only a matching selected synthetic ID is
canonicalized. Mismatched requests and non-Copilot providers are untouched.
For Anthropic Messages, a finalized canonical response model is normalized
back to the selected synthetic ID at `message_end`, while the canonical value
is retained as `responseModel` for diagnostics and signed-thinking replay.

Cache version 6 persists explicit routes and the account endpoint. Every older
version, including v2 and v4, is a normal miss because its complete semantics
cannot be reconstructed safely.
