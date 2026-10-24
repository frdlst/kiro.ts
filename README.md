# kiro.ts

A Pi package that adds a `kiro` provider: Kiro's models (Claude, GPT, `auto`, whatever Kiro lists) through
the Kiro runtime API, authenticated with a Kiro API key.

- Models, context windows, image support and reasoning knobs come from Kiro's
  `ListAvailableModels` at load, so new models appear without a code change.
- `/thinking` offers only the effort levels each model accepts. Reasoning streams for
  native-thinking Claude models and for the Claude 4.5 generation. GPT models only ever send
  a placeholder, which is hidden.
- Image input works on every model except `qwen3-coder-next`, including images returned by
  tools (`read` on a screenshot).
- Cost is the real billed figure: Kiro bills credits, and each request's credit usage is
  converted at $0.02/credit. The footer shows credits used this billing period, e.g.
  `12.9%/10k¢`.

## Install

```bash
pi install /path/to/kiro.ts      # local checkout, loaded in place
```

## API key

The provider reads `KIRO_API_KEY`. Keep it in the environment rather than `/login`: the model
list and the footer are fetched outside a request and only see the environment variable.
Without it, Pi hides the `kiro` models.

The Kiro dashboard's key management is broken, so `kiro-keys.mjs` does it from the terminal. It
uses your kiro-cli SSO login (`kiro-cli login`), the only credential that can manage keys.

```bash
node kiro-keys.mjs list
node kiro-keys.mjs create pi        # prints the key once, save it
node kiro-keys.mjs delete <keyId>
```

It needs Node 22.13+ (`node:sqlite`). Overrides: `KIRO_DB` (kiro-cli's `data.sqlite3`),
`KIRO_PROFILE_ARN`, `KIRO_REGION` (default `us-east-1`).

## Settings

- `KIRO_USD_PER_CREDIT`: default `0.02` (Kiro Power in-plan). Set `0.04` if overage billing is
  enabled on your account.

## Limits

- Output token counts are estimates. Kiro reports exact input usage and credits, not tokens.
- The footer counts this session's usage on top of the figure fetched at session start. Credits
  spent elsewhere (kiro-cli, Kiro IDE) show up after a restart.
- At most 100 images per request. Older images are dropped from history past that.
- Region is fixed to `us-east-1`.

## Test

```bash
KIRO_SELFTEST=1 pi --list-models kiro    # nine "[kiro] selfCheck ok" lines on stderr
```

Maintenance notes (wire protocol, measurements, re-discovery playbook) are in `AGENTS.md`.
