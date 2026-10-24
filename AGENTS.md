# kiro.ts

Pi package: a `kiro` provider (`extensions/kiro.ts`) plus `kiro-keys.mjs`, a CLI for minting
Kiro API keys. No build step, no runtime dependencies. User docs are in `README.md`; this file
holds the maintenance notes. Everything below was derived empirically; none of it is publicly
documented by AWS. If Kiro changes and the provider breaks, the **Re-discovery playbook** at the
bottom is the fastest way back.

| File | Auth | Purpose |
|---|---|---|
| `extensions/kiro.ts` | API key | the provider itself |
| `kiro-keys.mjs` | SSO (kiro-cli) | list/create/delete API keys |

The split is deliberate: the provider has exactly one auth path, and the only
code that needs SSO is the thing that structurally requires it — minting keys.

Rules:
- Discover model capabilities from `ListAvailableModels`. Don't hardcode them by model name.
- Only send `additionalModelRequestFields` a model's own schema declares.
- Keep SSO out of the provider.
- Use pi-ai/pi-coding-agent helpers where they exist (see "pi version compatibility").

Test: `KIRO_SELFTEST=1 pi --list-models kiro` with the package installed (see "The tool-result
ordering bug" for the expected output). Pi docs: `custom-provider.md`, `extensions.md`,
`packages.md` in the Pi install's `docs/`.

## Architecture in one paragraph

`kiro.ts` registers a pi provider called `kiro` with a custom `streamSimple`.
It speaks directly to the Kiro runtime API, authenticated by a long-lived API
key in `KIRO_API_KEY`. No token refresh, no sqlite, no kiro-cli dependency at
runtime.

## Authentication

The server distinguishes credential kinds with a **`TokenType` header**
(`_Ma` in the bundle maps `{external_idp: EXTERNAL_IDP, machine_token:
KIRO_MACHINE_TOKEN, api_key: API_KEY, IdC: SSO_OIDC}`).

| | API key (provider) | SSO token (`kiro-keys.mjs`) |
|---|---|---|
| Source | `KIRO_API_KEY` | kiro-cli sqlite store |
| `TokenType` | `API_KEY` | `SSO_OIDC` |
| Lifetime | until deleted (optional `expiresAt`) | ~1 hour, needs refresh |
| `profileArn` | **not needed**, key is profile-bound | required, via `ListAvailableProfiles` |
| Can manage API keys | no — `"Unsupported token type"` | yes |

An API key sent as a plain bearer **without** `TokenType: API_KEY` is rejected
with `"The bearer token included in the request is invalid."` — which looks
like a bad key but is really a missing header.

The provider registers `apiKey: "$KIRO_API_KEY"`, so pi resolves the key and
passes it to `streamSimple` as `options.apiKey`. With the variable unset, pi
hides the kiro models and reports its own "No API key found" instead of a
failed request. The two management RPCs (`ListAvailableModels` at load,
`GetUsageLimits` at session start) run outside a request and read
`KIRO_API_KEY` directly, so keep the key in the environment: a key stored with
`/login` reaches requests but not the model list or the footer.

SSO auth used to be a fallback inside the provider (read from kiro-cli's sqlite
store, refreshed via `kiro-cli whoami`). It was removed once API keys were
working: it was a second code path, a `node:sqlite` dependency, a subprocess
call, and an hourly expiry failure mode, all to do something the key does
better. If you ever need it back, `kiro-keys.mjs` still contains the whole
pattern — token read, expiry check, `whoami` refresh.

To mint a key: `CreateApiKey` takes `{profileArn, label, expiresAt?}`.
**`rawKey` is returned exactly once** — capture it or the key is dead weight.
`ListApiKeys` shows only `keyPrefix`; `DeleteApiKey` takes `{profileArn,
keyId}`. There are no scopes. (Deleting a nonexistent `keyId` returns a 500
from Kiro rather than a 404 — upstream bug, not yours.)

## Wire protocol

Two bindings exist for the same `GenerateAssistantResponse` operation. **Use
the RPC one.**

| | Legacy REST | RPC ("v3") — what we use |
|---|---|---|
| URL | `POST runtime.<region>.kiro.dev/generateAssistantResponse` | `POST runtime.<region>.kiro.dev/` |
| Selector | path | `x-amz-target: KiroRuntimeService.GenerateAssistantResponse` |
| Content-Type | `application/json` | `application/x-amz-json-1.0` |
| Models | **only `claude-sonnet-4.5` + `claude-haiku-4.5`** | all 14 |

Everything is awsJson1.0: `POST /` with an `x-amz-target` header. Management
APIs work the same way against `management.<region>.kiro.dev`.

### The User-Agent is an access gate

This is the single least obvious thing in the whole integration. The runtime
returns `403 "User is not authorized to make this call"` for unrecognised
clients, *regardless of how valid your token is*. The UA is what unlocks it:

- `kiro-cli/2.21.4` → only reaches the legacy REST binding.
- `aws-sdk-js/1.0.0 KiroCLI/... KAS/... app/AmazonQ-For-CLI` → full v3 access.

If you start getting blanket 403s, re-capture the UA (see playbook). A 403 here
almost never means "your token is bad" — that produces
`"The bearer token included in the request is invalid."` instead.

### Request envelope

```jsonc
{
  // profileArn is accepted but unnecessary with an API key — the key is
  // profile-bound, which is why the provider does no profile lookup.
  "agentMode": "vibe",
  "additionalModelRequestFields": { /* per-model, see below */ },
  "conversationState": {
    "chatTriggerType": "MANUAL",
    "conversationId": "<uuid>",
    "history": [ /* alternating userInputMessage / assistantResponseMessage */ ],
    "currentMessage": { "userInputMessage": { /* ... */ } },
    "agentContinuationId": "<uuid>",
    "agentTaskType": "vibe",
    "rootConversationId": "sess_<uuid>"
  }
}
```

Constraints learned the hard way:

- History **must strictly alternate** user/assistant. Tool results are not
  their own turn — they attach to the *following* `userInputMessage` via
  `userInputMessageContext.toolResults`. `buildEntries()` handles both.
- There is **no system-prompt field** on this binding. A top-level
  `systemPrompt` is accepted by the older REST binding's schema but returns
  `REQUEST_BODY_INVALID` here. We inline it into the first user turn.
- `origin` is a validated enum (`AI_EDITOR`, `CLI`, `IDE`, `KIRO_CLI`, …).
  Invalid values give `REQUEST_BODY_INVALID`.
- Unknown *top-level* keys are ignored silently, but unknown keys inside
  `additionalModelRequestFields` are a hard `ValidationException`.
- Tool specs go on `currentMessage` only. Kiro builds the Bedrock `toolConfig`
  from the current turn: with no specs anywhere, a history containing tool
  calls fails with `The toolConfig field must be defined when using toolUse and
  toolResult content blocks`, while specs on the current turn alone work.
  Repeating them on every history turn (the old behaviour) was pure payload.
  Probed 2026-09-30 on claude-haiku-4.5 and confirmed in a claude-sonnet-5 tool
  loop with echoed reasoning.

### Response events

AWS event-stream binary framing (`frames()` decodes it; CRCs are skipped
deliberately — TLS covers integrity).

| Event | Meaning |
|---|---|
| `assistantResponseEvent` | `{content}` text delta |
| `reasoningContentEvent` | `{text?, signature?}` native reasoning delta |
| `toolUseEvent` | `{toolUseId,name,input?,stop?}` streamed tool call |
| `metadataEvent` | `{stopReason}` — `END_TURN`/`TOOL_USE`/`MAX_TOKENS` |
| `contextUsageEvent` | `{contextUsagePercentage}` → exact input tokens |
| `meteringEvent` | `{unit:"credit", usage}` → **real billed cost** |
| `initial-response` | ignorable |

## Reasoning: three different mechanisms

This took the longest to work out. **Which mechanism a model uses is published
in its own schema** by `ListAvailableModels` — never hardcode it by name.

Read `additionalModelRequestFieldsSchema.properties`:

1. **`thinking` present** (opus-5, sonnet-5, opus-4.8, opus-4.7, 4.6 family) —
   send `thinking: {type:"adaptive", display:"summarized"}`. **This is what
   makes reasoning stream at all.** Without `display:"summarized"` you get a
   single `reasoningContentEvent` containing only an opaque `signature` and no
   text, which looks exactly like "reasoning is unavailable". It is not — you
   just did not ask for it. Effort also matters: opus-4.7 only produced
   reasoning at `max`. With thinking off (no level, e.g. branch summaries) send
   `thinking: {type:"disabled"}`, unless the schema's `thinking.type` enum
   omits `disabled`: some models list only `adaptive` and 400 on it, so the
   field is left out there.
2. **`reasoning.effort` present, no `thinking`** (gpt-5.6-\*) — send
   `reasoning: {effort}`. These return a `"..."` placeholder rather than real
   reasoning text; that is upstream behaviour, not a bug here.
3. **No schema at all, Claude 4.5 generation** — these honour a legacy
   *prompt directive*: putting
   `<thinking_mode>enabled</thinking_mode><max_thinking_length>N</max_thinking_length>`
   in the system prompt makes them emit literal `<thinking>…</thinking>` tags
   inline in the **text** channel. `ThinkingTagSplitter` pulls those back out
   (streaming-safe across chunk boundaries). `auto` and `qwen3-coder-next`
   ignore the directive, so they get nothing.

   `N` is a single constant (`DIRECTIVE_BUDGET = 30_000`). A per-level map was
   tried and removed: directive models emit 1000–2100 chars whatever number is
   sent, so the map was six knobs controlling nothing. Likewise the splitter
   recognises `<thinking>` only — `think`/`reasoning`/`thought` were carried on
   spec and never once observed. If a new tag does appear, widen it back to a
   list rather than guessing at more.

Effort field name differs by family — `output_config.effort` for Claude,
`reasoning.effort` for GPT — and the valid enum differs per model (4.6 has no
`xhigh`). Each model's `thinkingLevelMap` maps a level to itself when the enum
lists it and to `null` otherwise, so /thinking only offers real levels and pi
clamps the session level for us. pi clamps **up** first: a saved default of
`xhigh` becomes `max` on the 4.6 models.

### Which models actually show reasoning, and at what effort

**Re-measured 2026-09-20: every native-thinking Claude model now returns
summarized reasoning text at every effort level, `low` included.** Kiro switched
its summarizer on across the board at some point after the original
measurements. The old per-effort matrix recorded which models were silent and is
gone because none of them are any more. Reasoning characters on the
trial-division primality prompt:

| model | low | max |
|---|---|---|
| claude-sonnet-5 | 321 | 1128 |
| claude-opus-5 | 188 | 293 |
| claude-opus-4.8 | 275 | 465 |
| claude-opus-4.7 | 163 | 637 |
| claude-opus-4.6 | 234 | 916 |
| claude-sonnet-4.6 | 75 | 287 |
| gpt-5.6-\* | `...` | `...` |
| claude-\*-4.5 (directive) | 1000–2100 chars, does not need high effort |

Takeaways:
- Reasoning text is still **adaptive** and higher effort still buys more of it,
  but no model is silent at `low` any more.
- **GPT models still never emit real reasoning** — always the 3-char `"..."`
  placeholder, at every effort level. The extension filters it out rather than
  drawing an empty thinking block. **Read the next section before touching that
  filter** — the obvious way to write it corrupts every other model's output.
- `auto` and `qwen3-coder-next` have no reasoning mechanism at all.
- This changed upstream with no notice, so treat every "model X does not reason"
  claim here as a measurement with a date on it, not a capability. The probe is
  one `GenerateAssistantResponse` call counting `reasoningContentEvent` text.

### Dropped reasoning punctuation (fixed — the filter is a trap)

Symptom: reasoning reads as though punctuation went missing — `kiro.ts`
rendered as `kirots`, `"trust those results. I should stop"` as `"those
resultsI should stop"`, and section breaks silently collapsing.

Cause was the GPT placeholder filter, written as
`if (!/^\.*$/.test(text.trim())) emit(text)`. Reasoning arrives as many small
deltas and **punctuation routinely arrives as its own delta**. After `trim()`,
`".\n\n"` becomes `"."` and matches; `" "` and `"\n\n"` become `""`, which
`\.*` also matches. So the filter silently deleted every whitespace-only and
period-only delta for *every* model.

Measured on one short `claude-opus-5` response, straight off the wire:

```
reasoning deltas: 462 | dropped by the filter: 8
dropped values: [".\n\n", " ", " ", ".\n\n", "\n\n", ".", "\n\n", ".\n\n"]
wire    : "...on this kind of input.\n\nInsertion sort runs at O(n + Inv"
rendered: "...on this kind of inputInsertion sort runs at O(n + Inv"
```

**Fix:** `reasoningFilter()` suppresses placeholder deltas only *until the
first real reasoning delta arrives*, then passes everything through untouched.
GPT's entire reasoning output is the placeholder, so it stays suppressed; every
other model loses nothing. Guarded by a `selfCheck` assertion with deltas
copied verbatim off the wire.

To re-measure after any change to that path, capture raw deltas directly from
the runtime (see the re-discovery playbook) and compare the joined wire text to
what the extension renders — they must be byte-identical once reasoning starts.
A cheap proxy on rendered output: `/[a-z][A-Z]/` should find **zero** matches;
those glue artifacts are what a dropped `".\n\n"` leaves behind.

Note: the same symptom in *Kiro Crew* is unrelated — it is Python and drives
`kiro-cli` rather than the runtime, so it never had this filter.
- The 4.5 generation (prompt-directive path) is by far the most verbose, and
  unlike the native path it does not need high effort to trigger.

### Confirming a model is configured correctly

A model answering instantly with no reasoning looks like thinking was never
switched on. Compare latency and credits against `thinking: disabled` before
concluding the request is malformed — extended thinking costs both even when the
summary is withheld. Historical example, `claude-sonnet-5` back when Kiro's
summarizer was off for it:

| fields | latency | credits | reasoning text |
|---|---|---|---|
| `thinking: disabled` | 2.8s | 0.029 | none |
| `adaptive` + `display: summarized`, effort `max` | 10.2s | 0.170 | none (signature only) |

**3.6× the latency and 5.9× the credits** — the model was doing the extended
thinking it was asked for and returning only a `signature`. It returns summaries
too now, so this is a diagnostic method rather than a live quirk.

To see exactly what was sent, load pi's payload logger alongside the provider:
`mkdir -p .pi && pi -e <pi>/examples/extensions/provider-payload.ts` appends
every request payload (and each response status) to `.pi/provider-payload.log`
under the current directory; without the `.pi/` directory it only reports
ENOENT. It works because `streamKiro` calls `options.onPayload`, which feeds
pi's `before_provider_request` hook. Fields and echoed reasoning per request:

```
node -e 'for (const e of require("fs").readFileSync(".pi/provider-payload.log", "utf8").split("\n\n")) {
  if (!e.startsWith("{")) continue; const p = JSON.parse(e);
  console.log(JSON.stringify(p.additionalModelRequestFields ?? null), "echoed:",
    p.conversationState.history.filter((h) => h.assistantResponseMessage?.reasoningContent).length) }'
```

This replaced a `KIRO_DEBUG` logger that printed the same summary. Raw stream
frames are visible the same way through `provider_stream_event`
(`examples/extensions/debug-provider.ts`, then `/debug-provider`).

### The two mechanisms are mutually exclusive

The `<thinking_mode>` directive is ignored while native thinking is active —
the model will not narrate inline *and* think natively. Disabling the native
path re-enables the directive on models that support it:

| claude-opus-4.7 | inline tags | native reasoning |
|---|---|---|
| directive + `thinking: disabled` | **185 chars** | — |
| directive + `adaptive/summarized` @max | — | 278 chars |

So 4.7 can be made to narrate at low effort by turning native thinking off.
The extension does not do this: native reasoning at `max` is both better
reasoning and better text. Worth knowing if a future model surfaces nothing
natively.

## Cost and credits

Kiro bills **credits**, not tokens, so pi's per-million-token `cost` fields
cannot express it; they stay zero and we set `usage.cost` directly from the
`meteringEvent` of each request.

- `GetUsageLimits` → plan, `currentUsage`, `usageLimit`, `overageRate`. The
  provider no longer calls it: see below.
- In-plan rate is not exposed by the API. Kiro Power is $200 / 10,000 credits
  = **$0.02/credit**, hardcoded as `USD_PER_CREDIT`.
- Once `currentUsage >= usageLimit`, billing switches to `overageRate`
  (currently $0.04/credit). The provider used to call `GetUsageLimits` once a
  session to pick between the two — a network round-trip to choose between two
  constants, and a dead branch while `overageStatus` is `DISABLED` on the
  account. **If you enable overage, set `KIRO_USD_PER_CREDIT=0.04`** rather
  than reinstating the lookup.
- `rateMultiplier` per model (qwen 0.05 … opus 2.2) explains why identical
  prompts cost wildly different amounts. Reported by `ListAvailableModels`, but
  the provider does not read it — `meteringEvent` already returns the multiplied
  credit figure.

## Credit status bar

`ctx.ui.setStatus("kiro", …)` writes a persistent entry in pi's footer:

```
12.9%/10k¢
```

Deliberately terse, mirroring pi's own `13.1%/1.0M` context readout (`¢` marks
the unit as credits). It **cannot** be placed on the stats line itself:
`footer.js` builds `lines = [pwdLine, statsLine]` and then pushes extension
statuses as their own row, so an extension gets a line, never a slot. Status
text only has whitespace collapsed (`sanitizeStatusText`), so `%` and `¢`
survive.

`GetUsageLimits` is called **once** per session (`session_start`); after that the
figure is incremented locally from each request's `meteringEvent`, which is the
same number Kiro bills. No management RPC per turn. It can drift low if credits
are spent elsewhere (kiro-cli, Kiro IDE) during a session — restarting pi
resyncs. Refreshed on `agent_end` and `model_select`; shown only while a `kiro`
model is active. In print/JSON mode `ctx.ui` is pi's no-op context, so `-p`
output stays clean without a guard.

`GetUsageLimits` reports the **current billing period only** — there is no
all-time total anywhere in the API. Useful fields: `currentUsageWithPrecision`
(fractional, e.g. `1284.83`), `usageLimitWithPrecision`, `nextDateReset` (unix
seconds), `overageRate`, `overageConfiguration.overageStatus`.

## Images (input)

Wired up and verified end-to-end. Wire format, from the KAS bundle's Smithy
schema:

```
UserInputMessage members: content, userInputMessageContext, origin, images, documents, modelId
ImageBlock  = { format: ImageFormat, source: ImageSource }
ImageFormat = "gif" | "jpeg" | "png" | "webp"      (note: no "jpg")
ImageSource = { bytes: <blob> }
```

awsJson1.0 serialises a blob as base64 and pi supplies base64, so the payload
passes straight through — no decode/re-encode. Images attach to **user turns
only**; there is no image channel on `assistantResponseMessage`.

### The block shape pi actually sends

What arrives in a provider's context is pi's flat `ImageContent`:

```json
{"type":"image","mimeType":"image/png","data":"iVBORw0KGgo…"}
```

Older pi docs showed a nested `{type:"image", source:{type:"base64", mediaType,
data}}` form. The first version matched only that shape, silently dropped every
real image, and the models politely reported "the file came through empty".
Worse, the self-check asserted the *documented* shape, so it passed while the
feature was completely broken. As of pi 0.99 the nested form is gone from both
the docs and the types (`sendUserMessage` takes the same `ImageContent`), so
`imagesOf()` reads only the flat shape. **When a doc and a probe disagree, the
probe wins** — dump the real blocks before writing the mapping.

Unmappable images are dropped rather than sent (an unknown format fails the
whole request) but the drop is logged to stderr — a silent drop is exactly what
hid the bug above.

### At most 100 images per request

Kiro rejects a request carrying more than 100 inline images (`too many inline
media segments: 101 exceeds limit 100`, `IMAGE_COUNT_EXCEEDED`), which a
screenshot-heavy loop reaches in a few dozen turns. `capImages()` keeps the
newest 100 and drops older ones, with a stderr note. pi 0.99 can describe the
limit (`inputLimits.images.maxPerRequest`) but does not yet enforce it on
history, so the cap stays in the provider until it does.

### Measured support — the catalogue lies

`supportedInputTypes` reports `["TEXT","IMAGE"]` for **all 14** models. Sending
a real PNG to each:

| result | models |
|---|---|
| sees the image | `auto`, all 9 `claude-*`, `gpt-5.6-luna`, `gpt-5.6-terra` |
| **rejects it** | `qwen3-coder-next` — 400 `IMAGE_FORMAT_UNSUPPORTED`, kills the whole request |
| inconclusive | `gpt-5.6-sol` — 500 `MODEL_TEMPORARILY_UNAVAILABLE` (capacity, not images; siblings pass) |

Hence `NO_IMAGE`. Re-measure before trusting the catalogue on a new model: send
a 64×64 half-red/half-blue PNG and ask for the two colours — always with a
control run that omits the image, since a model answering from the filename
alone looks identical to one that can see.

`documents` is a sibling member (`{data, name, mimeType}`) if PDF/DOCX input is
ever wanted.

### Images returned by tools (the `read`-a-screenshot case)

Kiro's tool-result schema carries **no image member**:

```
ToolResultContentBlock members -> text, json
```

So when a tool returns an image — pi's `read` on a `.png` returns an image
content block — there is nowhere in the tool result to put it. The text
extraction keeps only text blocks, so the result reached Kiro as the literal
string `"ok"` and
the model correctly reported seeing nothing. The symptom looks exactly like a
blind model or a broken paste: *"I can't read PNG images"*.

Since this binding attaches tool results to the **following user turn**, and
that turn is the one place `images` is legal, tool-result images are hoisted
onto it and the result text says so:

```
toolResults: [{ toolUseId, status, content: [{ text: "[1 image(s) from this tool are attached to this message]" }] }]
images:      [{ format: "png", source: { bytes: "…" } }]
```

Gated on the model actually accepting images — pi filters user-attached images
by the registered `input` types, but a tool can return an image to *any* model,
so without the guard a `read` of a screenshot under `qwen3-coder-next` would
400 the whole conversation. Both halves are covered by `selfCheck`.

Verified end-to-end: `pi -p --provider kiro --model <m> "Read <path.png> and
tell me what it shows"` → `gpt-5.6-luna`, `claude-sonnet-4.5` and
`claude-opus-5` all describe the image correctly.

### Reasoning must be echoed back — but only when signed

`AssistantResponseMessage` declares four members:

```
content, messageId, toolUses, reasoningContent
reasoningContent -> { reasoningText: { text, signature } }
```

This extension originally sent only `content` + `toolUses`. In an agentic loop
that means every turn is handed a history with its own prior *thinking* removed,
so conclusions reached in step 3 are simply not present in step 4 and get
re-derived — observed as a `claude-opus-5` high-effort session making 31 tool
calls (all distinct, so *not* the tool-result ordering bug) while repeatedly
re-establishing things it had already worked out.

**The signature is mandatory.** Kiro forwards `reasoningContent` as an
Anthropic `thinking` block, which is signature-verified. Echoing an unsigned
one fails the entire request:

```
ValidationException: messages.1.content.0.thinking.signature: Field required
```

Measured on `claude-opus-4.8` — it kills the conversation, it does not degrade
gracefully. So `buildEntries` echoes a thinking block **only** when it carries a
`thinkingSignature`. That excludes directive-mode models (`claude-*-4.5`), whose
"thinking" is text this extension scraped out of `<thinking>` tags rather than
model reasoning, and the GPT placeholder models.

#### Where the signature comes from

Kiro sends it as a **signature-only event** — one per reasoning block, after the
last text delta:

```
Measured: keys=signature  textLen=0  sigLen=548
```

**The signature is the reasoning** for any model that withholds its summary: the
work is done and billed either way, and the chain of thought rides in the
signature blob.

| model | reasoning event shape | signature bytes |
|---|---|---|
| every native-thinking `claude-*` | many text deltas, then signature | 364–4504 |
| **gpt-5.6-sol / luna / terra** | `text="..."` placeholder + signature | 1730–4338 |
| claude-*-4.5 (directive) | no reasoning events at all | — |

`claude-sonnet-5` was signature-only with zero text until Kiro enabled its
summarizer; it now streams text like its siblings. The echo stays gated on the
**signature alone**, never on visible text — requiring non-empty text would
exclude every GPT model, and would have excluded sonnet-5 before it changed. For
those, a thinking block is created purely to hold the signature; pi keeps signed blocks
whether or not they contain text:

```js
// pi's own rule, from the bundle:
isSameModel && block.thinkingSignature ? block : (!block.thinking.trim() ? [] : ...)
```

(The `isSameModel` term means switching models mid-session drops signed blocks —
correct, since a signature is only valid for the model that issued it.)

Two traps in the streaming path:

- `emitThinking` returns early on an empty delta, so attaching the signature
  inside it drops every single one.
- The event can arrive after the block has been closed by following text, so the
  block is held by reference (`thinkingBlock`), not by index.

pi also validates signatures with `isValidThoughtSignature`
(`length % 4 === 0` and base64), and **every GPT signature is `% 4 == 2`**.
Measured: they survive anyway on the custom-provider path and echo correctly.
Worth remembering if GPT reasoning continuity ever silently stops working.

#### Reasoning is emitted only when the task warrants it

A trivial tool loop ("read two files, add them") produces **no reasoning events
at all**, on any model. An early version of this measurement concluded sonnet-5
and the GPT models had no signatures; the task was simply too easy. Always probe
with work that requires actual deliberation — trial-division primality over
`391 397 403 409` is a reliable trigger.

Verified end-to-end (multi-step tool loop, all answers correct), measured with
the old `KIRO_DEBUG` logger, whose `signed` count always equalled
`reasoningEchoed`:

| model | reasoning blocks echoed |
|---|---|
| claude-sonnet-5 @max | 2 |
| gpt-5.6-sol @max | 3 |
| gpt-5.6-luna @max | 3 |
| gpt-5.6-terra @high | 4 |
| claude-opus-4.8 @max | 2 |
| claude-opus-5 @xhigh | 1 |
| claude-sonnet-4.5 @high (directive) | 0 — correct, nothing to sign |

Re-checked 2026-09-30 on claude-sonnet-5 @high: 1 signed block echoed, with tool
specs on the current turn only. Every echoed block is signed by construction
(`buildEntries` only emits signed ones, and `selfCheck` guards it), so an
unsigned echo cannot be the cause of a 400.

**Known test gap:** `selfCheck` covers all three history-side rules (signed
echo, signature-only echo, unsigned never echoed) and catches each mutation.
It does **not** cover the streaming-side capture — deleting the carrier-block
creation is `NOT CAUGHT`, because the frame loop is a closure with no injection
point and a test that rebuilt it would only re-state the code. The live check
is a non-zero echo count on the second request of a reasoning-heavy tool loop,
read from the payload log (see "Confirming a model is configured correctly").

#### Can the signature be decoded to show the hidden reasoning? No.

Asked and answered empirically — don't spend time on it again.

`gpt-5.6-*` signatures are a `~~`-delimited envelope whose header is plaintext
JSON (which is also why their length is `% 4 == 2` — never plain base64):

```json
{ "encryptionRegion": "us-west-2", "modelHash": "…",
  "slots": [{ "id": "rs_…", "encrypted": "rsn_…" }], "v": 1 }
```

The `encrypted` payload carries the literal marker `aws-crypto-public-key` — AWS
Encryption SDK envelope encryption against a KMS key in `us-west-2`. Measured
1355B at **7.77 bits/byte**.

`claude-*` signatures are a protobuf envelope: `field 2` = 4237B at **7.96
bits/byte** (ciphertext), `field 3` = 1. Readable metadata only — an internal
model codename (`claude-saffron8`, `claude-quince8`), the string `thinking`, and
an AWS account id.

Entropy that near the 8.00 ceiling rules out plaintext or compressed text. The
reasoning is sealed for the provider, not encoded for us. Models that *do* show
their reasoning send it as plain text deltas next to the signature, so there is
never anything to decode: if the text is missing, it was withheld on purpose.

## Everything else is discovered

`ListAvailableModels` also supplies `tokenLimits` (context window + max
output), `supportedInputTypes`, and `promptCaching`. The model list is built
from it at extension load, so new Kiro models appear without a code change.
If the call fails (offline, bad key) the provider registers no models, and pi
starts anyway on another provider's model or with its no-models message.

## The tool-result ordering bug (fixed — do not reintroduce)

This one produced an infinite reasoning loop and is easy to recreate, so it is
worth understanding rather than just reading the fix.

Kiro has no dedicated tool-result turn: results ride on the **next user turn**
via `userInputMessageContext.toolResults`. The original `buildEntries` only
flushed pending results when a *user message* arrived. In an agentic loop no
user message ever arrives — the sequence is assistant → toolResult → assistant
→ toolResult — so results accumulated and were dumped into a single trailing
turn, while the consecutive assistant turns got merged into one by the
alternation pass:

```
0 USER   "check the file"
1 ASSIST toolUses=[t1,t2,t3]            <- three separate turns, merged into one
2 USER   toolResults=[
          t1 "lines=640 bytes=24008",   <- stale
          t2 "lines=641 bytes=24096",   <- fresh
          t3 "lines=641 bytes=24096"]
```

The model is shown every result it has ever received, stale and fresh together,
unpaired from the calls that produced them, and the blob grows every turn. The
observed failure was a model insisting "those parallel calls raced each other,
I'm seeing conflicting file states" and re-verifying forever — it was not
confused, it was being handed two contradictory readings of the same file in
the same message, on every single turn. Any sufficiently long tool loop
eventually derails.

**Fix:** flush pending results into their own user turn *before* pushing the
next assistant turn, giving proper alternation:
`user → assistant(t1) → user(result t1) → assistant(t2) → user(result t2)`.

**Guard:** `KIRO_SELFTEST=1 pi --list-models kiro` runs `selfCheck()`, which
covers every piece of non-obvious logic in this file. For history it asserts the
pairing *and* the turn shape (user/assistant alternating, five entries). Checking
the shape matters: the first version of this check only matched call ids to
result ids, and the buggy merged history passed it — merging preserves ids while
rewriting history to imply the model called t2 already knowing t1's result. The
checks use `node:assert/strict`, so a failure prints the message plus a diff.
Expect nine `ok` lines:

```
[kiro] selfCheck ok — 5 entries, tool results correctly paired
[kiro] selfCheck ok — splitter stable across chunk boundaries
[kiro] selfCheck ok — reasoning filter lossless after first real delta
[kiro] selfCheck ok — images map to ImageBlock, jpg→jpeg, unsupported dropped
[kiro] selfCheck ok — tool-result images hoisted to the user turn, blocked when unsupported
[kiro] selfCheck ok — oldest images dropped at the 100-image request limit
[kiro] selfCheck ok — signed reasoning echoed back (incl. signature-only), unsigned never is
[kiro] selfCheck ok — system prompt, sections and tool deltas replayed from the transcript
[kiro] selfCheck ok — thinking type respects the model's schema enum
```

(The images line is preceded by an expected `dropping image: image/bmp …` note,
and the cap line by `dropped 2 old image(s)`: both are the checks exercising
the drop paths.)

The splitter half feeds one input whole, then one character at a time, and
requires identical output. It compares *coalesced runs* per channel, not raw
deltas — streaming splits deltas at arbitrary points, so asserting on delta
boundaries fails against correct code. Verify new assertions have teeth by
breaking the code on purpose; these mutations are known to be caught:
removing the tool-result flush, `safeLength`'s `>= CLOSE.length` guard, the
`this.open = !this.open` toggle, swapping `getCurrentSystemPrompt` for a naive
content concatenation (drops `sections`), swapping `getCurrentTools` for a flat
`toolsAdded` scan (ignores removals), reverting `buildEntries`' assistant
branch to a bare `else`, echoing unsigned reasoning, a cap that keeps the
oldest images, a reasoning filter that drops `.` deltas mid-stream, and not
sending the tool specs on the current turn.

## Known gaps

- **Output tokens** are a `length/4` estimate (pi's `estimateTokens`: text,
  thinking and tool-call arguments). Input tokens are exact (from
  `contextUsageEvent`). The API never reports token counts.
- **`/v1/responses`** exists on the runtime host and is genuinely
  OpenAI-Responses-shaped (`model`, `input`, `instructions`, `tools`,
  `reasoning`, `previousResponseId`; returns OpenAI-style error envelopes). If
  it could be reached it would replace this entire file with
  `api: "openai-responses"`. **It is server-side gated and cannot currently be
  used.** Investigated exhaustively — do not repeat this work without new
  information:
  - SSO bearer → 403 `access_denied` under every UA/header/body combination.
  - API key + `TokenType: API_KEY` → *authenticates* (the "invalid token"
    error disappears and the `profileArn is required` precondition is
    satisfied) but still 403 `"User is not authorized to make this call."`
  - All **22** values of the `Origin` enum → 403. Values outside the enum
    (`API`, `THIRD_PARTY`) give 400 `"Improperly formed request."` from either
    the header or the body — that is enum validation running before authz, not
    a bypass.
  - The same API key returns **200** on `GenerateAssistantResponse` and on
    every management operation, so the credential is valid and the block is an
    authorization policy on `CreateResponse` specifically.
  - `optInFeatures` contains no flag for it (`apiKeys`, `byUserAnalytics`,
    `dashboardAnalytics`, `modelConfiguration`, `overageConfiguration` only),
    and API keys have no scopes.
  - Re-checked 2026-09-20, including the awsJson binding the REST path had never
    been tried on: `x-amz-target: KiroRuntimeService.CreateResponse` **is a
    recognised operation** (a malformed body returns `ValidationException /
    REQUEST_BODY_INVALID`, not `UnknownOperationException`), but any well-formed
    body returns 403 `AccessDeniedException`. Same wall, one layer deeper: the
    operation exists and the account is not allowed to call it.

  Conclusion: unlaunched or allowlist-gated server side. Retry only after a
  Kiro release note suggests the Responses API has shipped — a one-line curl
  with an API key and `TokenType: API_KEY` will tell you immediately.

## Why this is a custom `streamSimple` and not a built-in pi `api`

pi ships nine API implementations (`docs/custom-provider.md`), and replacing this
file with one of them would be a large win. **None of them fit.** Checked
2026-09-20 against the live runtime; every probe below was one POST with a valid
API key and the unlocking UA:

| candidate | probe | result |
|---|---|---|
| `bedrock-converse-stream` | `POST /model/<id>/converse-stream` and `/converse`, plain and `anthropic.`-prefixed ids | `UnknownOperationException` |
| `bedrock-converse-stream` | `x-amz-target: AmazonBedrockFrontendService.ConverseStream`, `KiroRuntimeService.ConverseStream`, `.Converse` | `UnknownOperationException` |
| `anthropic-messages` | `POST /v1/messages`, `/messages` | `UnknownOperationException` |
| `openai-completions` | `POST /v1/chat/completions` | `UnknownOperationException` |
| `openai-responses` | `POST /v1/responses`, `x-amz-target: …CreateResponse` | recognised, **403 AccessDenied** (above) |

`bedrock-converse-stream` is the intuitive guess — Kiro *is* Bedrock underneath,
the events are AWS event-stream framed, and `additionalModelRequestFields` is a
Converse field name. It still cannot work: pi's implementation drives the AWS SDK
`ConverseStreamCommand` against a Bedrock Runtime endpoint, and
`runtime.<region>.kiro.dev` is a different Smithy service
(`com.amazon.kiro.runtimeservice`) that does not implement `Converse` at all. The
Bedrock resemblance is upstream of Kiro's own API, not exposed through it. The
request envelope is the giveaway: `conversationState` / `userInputMessage` /
`assistantResponseMessage` with tool results hanging off the *next* user turn has
no Converse equivalent.

So `GenerateAssistantResponse` is the only operation the account can reach, and a
custom `streamSimple` is the only way to speak it. Re-probe with the table above
if that changes; it takes under a minute.

## pi version compatibility

Custom providers track pi's provider contract, which does move. What has bitten
this file:

**0.86 — `Context` → `TranscriptContext`.** `streamSimple` no longer receives
`context.systemPrompt` or `context.tools`. The system prompt and tool
declarations arrive as **system-role messages inside `context.messages`**: the
leading one carries the base prompt and initial tools, later ones patch it
(appended `content`, `sections` replaced by name, `toolsAdded`/`toolsRemoved`).
The symptom was `message.content.filter is not a function` — a system message
fell through `buildEntries`' assistant branch, where `content` is `string |
TextContent[]` rather than a block array.

Use pi's own replay helpers, which **are importable from an extension**:

```ts
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
```

The extension alias map points `@earendil-works/pi-ai` at pi-ai's `compat`
entrypoint, and `compat` re-exports `index`, which re-exports `utils/transcript`.
A first pass at this fix hand-rolled the replay on the assumption the helpers
were unreachable; verify with a two-line probe extension before believing that
again. Hand-rolling also **silently drops `sections`**, so a prompt patch from
`before_agent_start` or a skill never reaches the model.

`buildEntries` now dispatches on `message.role === "assistant"` explicitly rather
than `else`, so an unrecognised role is skipped instead of being serialised as a
bogus empty assistant turn. Reverting that reproduces the crash and
`KIRO_SELFTEST=1` catches it.

**0.99 — provider hooks and helpers.** Nothing broke, but several hand-rolled
pieces had pi equivalents, adopted 2026-09-30:

- `streamKiro` calls `options.onPayload`, `options.onResponse` and
  `options.onProviderStreamEvent` (the `ProviderConfig.streamSimple` contract
  requires the first two). Before that, `before_provider_request`,
  `after_provider_response`, `provider_stream_event` and `/debug-provider` never
  saw Kiro traffic. Stream events are passed as `{ [eventType]: payload }`, the
  same union shape Bedrock's SDK events use.
- `apiKey: "$KIRO_API_KEY"` instead of a placeholder string (see Authentication).
- `thinkingLevelMap` marks unsupported levels `null`; pi hides and clamps them,
  which replaced the provider's own degrade ladder.
- `contentText`, `parseStreamingJson` and the `ThinkingContent` type from
  `@earendil-works/pi-ai`, `estimateTokens` from `@earendil-works/pi-coding-agent`.
  All are reachable from an extension through the same alias map as above.
- `SimpleStreamOptions.reasoning` is typed `ThinkingLevel`, which has no
  `"off"`: pi sends `undefined` for off, so there is nothing to compare against.
- Without a UI, `ctx.ui` is a no-op context, so `setStatus` needs no `hasUI`
  guard.
- Still true: `pi --list-models` swallows extension load errors, which is why
  the selfCheck failure is printed before it is rethrown.

## Re-discovery playbook

When the protocol changes, do not guess — the engine will tell you.

1. **The v3 engine is JavaScript, not Rust.** It lives at
   `~/AppData/Local/kiro-cli/kas/<version>/node_modules/@kiro/agent/dist/server/acp-server.js`
   (~11–21 MB, readable). It bundles the full Smithy schema for
   `com.amazon.kiro.runtimeservice`: operation list, HTTP traits, every struct,
   and the `_xx = "fieldName"` abbreviation table used to decode them.
   Resolve the version directory at runtime — it changes on update.

2. **Sniff the real traffic** — it is a Node process, so no TLS interception is
   needed. Write a preload that patches `http/https.request` (wrap
   `req.write`/`req.end` to capture bodies) and run:

   ```
   NODE_OPTIONS="--require ./sniff.cjs" kiro-cli chat --v3 --no-interactive \
     --model claude-sonnet-5 --effort high "hello"
   ```

   This is how the UA, the `agentMode`/`agentTaskType` envelope and
   `additionalModelRequestFields` were all captured. Note plain `kiro-cli chat`
   takes the Rust/v2 path and sniffs nothing — `--v3` is required. For this
   provider's own traffic no sniffing is needed: pi's payload and stream hooks
   show it (see "Confirming a model is configured correctly").

3. **Ask the control plane** before hardcoding anything:
   `ListAvailableModels` (schemas, limits, multipliers), `GetUsageLimits`
   (credits), `ListAvailableProfiles` (profileArn), `GetProfile` (opt-ins).

4. **Check the reference implementations** in `D:\Sourcery\pi-kiro-examples`
   (`pi-kiro`, `pi-kiro-dev`, `pi-provider-kiro`, and KiroCrew's Python
   source). They are heavily over-engineered, but their changelogs and
   conformance docs record real upstream behaviour — the `<thinking_mode>`
   directive was found there.

5. **Interpreting failures**:
   - `403 "User is not authorized"` → client gating, usually the UA, or an
     endpoint your account cannot reach at all (see `/v1/responses`).
   - `403 "bearer token ... invalid"` → token expired, or an API key sent
     without `TokenType: API_KEY`.
   - `400 "Unsupported token type"` → that operation does not accept API keys.
   - `400 INVALID_MODEL_ID` → you are on the legacy REST binding.
   - `400 "property 'x' is not defined in the schema"` → you sent a field this
     model's schema does not declare.
