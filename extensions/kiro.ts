/**
 * Kiro provider for pi.
 * ---------------------------------------------------------------------------
 * Talks directly to the Kiro runtime API (the "v3" binding, the same one the
 * kiro-cli v3 engine uses), authenticated with a Kiro API key.
 *
 * MAINTENANCE NOTES: see `AGENTS.md` at the package root. It documents the wire
 * protocol, the capability matrix, and — most importantly — how to
 * re-discover all of it from scratch when Kiro changes something.
 *
 * Design rules worth preserving:
 *   1. One auth path: `KIRO_API_KEY` + a `TokenType: API_KEY` header. Keys are
 *      profile-bound and long-lived, so there is no token refresh and no
 *      profile lookup. Key management lives in `kiro-keys.mjs` at the package root, which needs
 *      an SSO login — keep those two concerns apart.
 *   2. Model capabilities are DISCOVERED, not hardcoded. `ListAvailableModels`
 *      publishes a JSON schema per model describing exactly which reasoning
 *      knobs it accepts. Hardcoding "claude means X" was wrong twice already.
 *   3. The server rejects unknown properties in `additionalModelRequestFields`,
 *      so only send what a model's own schema declares.
 */
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ThinkingContent,
  type ThinkingLevel,
  type ToolCall,
  type TranscriptContext,
  contentText,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  parseStreamingJson,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/";
const MANAGEMENT = "https://management.us-east-1.kiro.dev/";

/**
 * The runtime 403s unrecognised clients. This exact string is what unlocks the
 * v3 binding — the plain "kiro-cli/x.y.z" UA only reaches the older REST
 * binding, which rejects every model except sonnet-4.5 and haiku-4.5.
 * Captured from the real engine; see AGENTS.md for how to re-capture.
 */
const USER_AGENT =
  "aws-sdk-js/1.0.0 KiroCLI/2.21.4 KAS/0.63.3 os/windows md/appVersion-2.21.4 app/AmazonQ-For-CLI";

/**
 * $/credit inside a Kiro plan (Power = $200 / 10,000 credits). If overage is
 * enabled, set KIRO_USD_PER_CREDIT to the overage rate (AGENTS.md, "Cost and credits").
 */
const USD_PER_CREDIT = Number(process.env.KIRO_USD_PER_CREDIT ?? 0.02);

// ---------------------------------------------------------------- auth

/**
 * Every Kiro API is awsJson1.0 RPC: POST to `/` with an x-amz-target header.
 * Auth is one Kiro API key (`ksk_…`; mint one with `node kiro-keys.mjs
 * create <label>`). Without `TokenType: API_KEY` it is rejected as "bearer token
 * invalid", which looks like a bad key but is a missing header. Requests get the
 * key from pi (`options.apiKey`); the management RPCs read `KIRO_API_KEY` directly.
 */
function rpcHeaders(target: string, key = process.env.KIRO_API_KEY): Record<string, string> {
  return {
    Authorization: `Bearer ${key?.trim()}`,
    TokenType: "API_KEY",
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": target,
    "User-Agent": USER_AGENT,
    "x-amz-user-agent": USER_AGENT,
  };
}

async function rpc(url: string, target: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: rpcHeaders(target),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Kiro ${target} ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

// ------------------------------------------------------ model catalogue

type EffortPath = "output_config" | "reasoning";

interface KiroModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Where this model wants its effort value, per its published schema. */
  effortPath: EffortPath | null;
  effortLevels: string[];
  /** Schema declares `thinking` → supports native streamed reasoning summaries. */
  nativeThinking: boolean;
  /** Schema's `thinking.type` enum; empty when unconstrained. */
  thinkingTypes: string[];
  /** `supportedInputTypes` contains IMAGE. */
  image: boolean;
  /** No schema, but honours the legacy `<thinking_mode>` prompt directive. */
  promptDirectiveThinking: boolean;
}

/**
 * `supportedInputTypes` claims IMAGE for every model, but qwen3-coder-next 400s
 * the whole request on any image. Re-measure new models (AGENTS.md, "Images").
 */
const NO_IMAGE = new Set(["qwen3-coder-next"]);

function parseModel(raw: any): KiroModelInfo {
  const properties = raw.additionalModelRequestFieldsSchema?.properties;
  const outputEffort = properties?.output_config?.properties?.effort;
  const reasoningEffort = properties?.reasoning?.properties?.effort;
  const effort = outputEffort ?? reasoningEffort;
  const id: string = raw.modelId;
  return {
    id,
    name: raw.modelName ?? id,
    contextWindow: raw.tokenLimits?.maxInputTokens ?? 200_000,
    maxTokens: raw.tokenLimits?.maxOutputTokens ?? 64_000,
    effortPath: outputEffort ? "output_config" : reasoningEffort ? "reasoning" : null,
    effortLevels: effort?.enum ?? [],
    nativeThinking: !!properties?.thinking,
    thinkingTypes: properties?.thinking?.properties?.type?.enum ?? [],
    image: (raw.supportedInputTypes ?? []).includes("IMAGE") && !NO_IMAGE.has(id),
    // Claude models with no schema at all (the 4.5 generation) still inline
    // <thinking> tags when asked via the prompt directive. Verified per model;
    // `auto` and qwen ignore it.
    promptDirectiveThinking: !properties && id.startsWith("claude-"),
  };
}

async function fetchModels(): Promise<KiroModelInfo[]> {
  const data = await rpc(MANAGEMENT, "KiroControlPlaneBearerService.ListAvailableModels", {
    origin: "AI_EDITOR",
  });
  return (data.models ?? []).map(parseModel);
}

// ------------------------------------------------------ usage status bar

/**
 * Current-period credit usage for pi's footer: fetched once per session, then
 * incremented from each request's `meteringEvent` (AGENTS.md, "Credit status bar").
 */
const usage = { used: 0, limit: 0 };

async function fetchUsage(): Promise<void> {
  const data = await rpc(MANAGEMENT, "KiroControlPlaneBearerService.GetUsageLimits", {});
  const credits = data.usageBreakdownList?.find((b: any) => b.resourceType === "CREDIT");
  if (!credits) return;
  usage.used = credits.currentUsageWithPrecision ?? credits.currentUsage ?? 0;
  usage.limit = credits.usageLimitWithPrecision ?? credits.usageLimit ?? 0;
}

function usageStatus(): string | undefined {
  if (!usage.limit) return undefined;
  // Mirrors pi's own footer style ("13.1%/1.0M"); ¢ marks the unit as credits.
  const compact = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
  return `${((usage.used / usage.limit) * 100).toFixed(1)}%/${compact(usage.limit)}¢`;
}

// ------------------------------------------------- request construction

interface UserEntry {
  userInputMessage: {
    content: string;
    modelId: string;
    origin: "AI_EDITOR";
    images?: unknown[];
    userInputMessageContext: { tools?: unknown[]; toolResults?: unknown[] };
  };
}
interface AssistantEntry {
  assistantResponseMessage: {
    content: string;
    toolUses?: { toolUseId: string; name: string; input: Record<string, unknown> }[];
    reasoningContent?: { reasoningText: { text?: string; signature?: string } };
  };
}
type Entry = UserEntry | AssistantEntry;

const isUser = (entry: Entry): entry is UserEntry => "userInputMessage" in entry;

/** pi's media types → Kiro's ImageFormat enum. Kiro has no "jpg", only "jpeg". */
const IMAGE_FORMATS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * pi's flat ImageContent → Kiro ImageBlock. Both sides are base64, so the data
 * passes straight through. An unmappable format would fail the *whole* request,
 * so it is dropped instead, loudly: a silent drop once hid every image (AGENTS.md).
 */
function imagesOf(content: Message["content"]): unknown[] {
  if (typeof content === "string") return [];
  const images: unknown[] = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    const format = IMAGE_FORMATS[block.mimeType];
    if (!format) {
      console.error(`[kiro] dropping image: ${block.mimeType} is not one of ${Object.keys(IMAGE_FORMATS).join(", ")}`);
      continue;
    }
    images.push({ format, source: { bytes: block.data } });
  }
  return images;
}

/**
 * Kiro rejects a request with more than 100 inline images (IMAGE_COUNT_EXCEEDED).
 * Keep the newest: a stale screenshot is the least useful thing in the history
 * (AGENTS.md, "At most 100 images per request").
 */
const MAX_IMAGES = 100;

function capImages(entries: Entry[], limit = MAX_IMAGES): void {
  let budget = limit;
  let dropped = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isUser(entry)) continue;
    const images = entry.userInputMessage.images;
    if (!images?.length) continue;
    if (budget <= 0) {
      delete entry.userInputMessage.images;
      dropped += images.length;
    } else if (images.length > budget) {
      entry.userInputMessage.images = images.slice(-budget);
      dropped += images.length - budget;
    }
    budget -= images.length;
  }
  // Silence here would look exactly like the model ignoring an old screenshot.
  if (dropped) console.error(`[kiro] dropped ${dropped} old image(s): over the ${limit}-image request limit`);
}

/** Budget the legacy `<thinking_mode>` directive advertises (one constant; AGENTS.md says why). */
const DIRECTIVE_BUDGET = 30_000;

/**
 * Build `additionalModelRequestFields` from the model's own schema.
 * `thinking.display: "summarized"` is what makes reasoning text stream at all —
 * without it Claude returns an opaque signature and nothing else.
 */
function modelRequestFields(info: KiroModelInfo, level?: ThinkingLevel): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  if (info.nativeThinking) {
    if (level) fields.thinking = { type: "adaptive", display: "summarized" };
    // Some schemas enumerate only "adaptive" and 400 on "disabled"; omit it there.
    else if (!info.thinkingTypes.length || info.thinkingTypes.includes("disabled")) fields.thinking = { type: "disabled" };
  }
  // thinkingLevelMap hides unsupported levels, so pi only sends ones the schema lists.
  if (level && info.effortPath && info.effortLevels.includes(level)) fields[info.effortPath] = { effort: level };
  return Object.keys(fields).length ? fields : undefined;
}

function buildEntries(messages: Message[], modelId: string, systemPrompt: string, allowImages = true): Entry[] {
  const entries: Entry[] = [];
  let pendingToolResults: unknown[] = [];
  // Kiro tool results have no image member, so tool-result images ride on the
  // user turn that carries the results (AGENTS.md, "Images returned by tools").
  let pendingImages: unknown[] = [];

  const pushUser = (content: string, images: unknown[] = []) => {
    const attached = allowImages ? [...pendingImages, ...images] : [];
    pendingImages = [];
    entries.push({
      userInputMessage: {
        content,
        modelId,
        origin: "AI_EDITOR",
        ...(attached.length ? { images: attached } : {}),
        userInputMessageContext: pendingToolResults.length ? { toolResults: pendingToolResults } : {},
      },
    });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      pushUser(contentText(message.content, ""), imagesOf(message.content));
    } else if (message.role === "toolResult") {
      const resultImages = allowImages ? imagesOf(message.content) : [];
      pendingImages.push(...resultImages);
      pendingToolResults.push({
        toolUseId: message.toolCallId,
        status: message.isError ? "error" : "success",
        content: [
          {
            text:
              contentText(message.content, "") ||
              (resultImages.length
                ? `[${resultImages.length} image(s) from this tool are attached to this message]`
                : message.isError
                  ? "error"
                  : "ok"),
          },
        ],
      });
    } else if (message.role === "assistant") {
      // Flush tool results into their own user turn BEFORE the next assistant
      // turn, or they pile up unpaired (AGENTS.md, "The tool-result ordering bug").
      if (pendingToolResults.length) pushUser("");
      const toolUses = message.content
        .filter((block): block is ToolCall => block.type === "toolCall")
        .map((block) => ({ toolUseId: block.id, name: block.name, input: block.arguments }));
      // Echo the model's own reasoning, or every agentic turn re-derives it. Only
      // SIGNED blocks: Kiro verifies them as Anthropic `thinking` blocks and 400s
      // unsigned ones, which rules out directive-mode text. The signature alone is
      // enough (AGENTS.md, "Reasoning must be echoed back — but only when signed").
      const thought = message.content.find(
        (block): block is ThinkingContent => block.type === "thinking" && !!block.thinkingSignature,
      );
      entries.push({
        assistantResponseMessage: {
          content: contentText(message.content, ""),
          ...(toolUses.length ? { toolUses } : {}),
          ...(thought
            ? {
                reasoningContent: {
                  reasoningText: { text: thought.thinking ?? "", signature: thought.thinkingSignature },
                },
              }
            : {}),
        },
      });
    }
  }
  if (pendingToolResults.length) pushUser("");

  // Kiro requires strictly alternating user/assistant turns.
  const merged: Entry[] = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (previous && isUser(previous) && isUser(entry)) {
      previous.userInputMessage.content = [previous.userInputMessage.content, entry.userInputMessage.content]
        .filter(Boolean)
        .join("\n\n");
      const target = previous.userInputMessage.userInputMessageContext;
      const source = entry.userInputMessage.userInputMessageContext;
      if (source.toolResults) target.toolResults = [...(target.toolResults ?? []), ...source.toolResults];
      const mergedImages = [
        ...(previous.userInputMessage.images ?? []),
        ...(entry.userInputMessage.images ?? []),
      ];
      if (mergedImages.length) previous.userInputMessage.images = mergedImages;
      continue;
    }
    if (previous && !isUser(previous) && !isUser(entry)) {
      previous.assistantResponseMessage.content = [
        previous.assistantResponseMessage.content,
        entry.assistantResponseMessage.content,
      ]
        .filter(Boolean)
        .join("\n\n");
      previous.assistantResponseMessage.toolUses = [
        ...(previous.assistantResponseMessage.toolUses ?? []),
        ...(entry.assistantResponseMessage.toolUses ?? []),
      ];
      if (!previous.assistantResponseMessage.toolUses.length) delete previous.assistantResponseMessage.toolUses;
      continue;
    }
    merged.push(entry);
  }

  capImages(merged);

  // This binding has no system-prompt field, so it rides on the first user turn.
  const first = merged.find(isUser);
  if (systemPrompt && first) {
    first.userInputMessage.content =
      `<system>\n${systemPrompt}\n</system>\n\n${first.userInputMessage.content}`.trim();
  }
  return merged;
}

/**
 * pi (0.86+) hands providers a `TranscriptContext`: the prompt and tools live in
 * system-role messages that later ones patch. `getCurrentSystemPrompt` and
 * `getCurrentTools` replay them, sections included; do not hand-roll it.
 */
function buildRequest(context: TranscriptContext, info: KiroModelInfo, level: ThinkingLevel | undefined) {
  const tools = getCurrentTools(context.messages).map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters },
    },
  }));

  let systemPrompt = getCurrentSystemPrompt(context.messages);
  if (info.promptDirectiveThinking && level) {
    systemPrompt =
      `<thinking_mode>enabled</thinking_mode><max_thinking_length>${DIRECTIVE_BUDGET}</max_thinking_length>\n${systemPrompt}`.trim();
  }

  // No system-prompt field on this binding: buildEntries skips the transcript's
  // system messages and carries the replayed prompt on the first user turn.
  const entries = buildEntries(context.messages, info.id, systemPrompt, info.image);
  let current = entries.pop();
  if (!current || !isUser(current)) {
    if (current) entries.push(current);
    current = { userInputMessage: { content: "Continue.", modelId: info.id, origin: "AI_EDITOR", userInputMessageContext: {} } };
  }
  // Kiro builds the request's toolConfig from the current turn alone, so the
  // specs go there once instead of on every history turn (probed 2026-09-30).
  if (tools.length) current.userInputMessage.userInputMessageContext.tools = tools;

  const additionalModelRequestFields = modelRequestFields(info, level);
  return {
    agentMode: "vibe",
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      history: entries,
      currentMessage: current,
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: "vibe",
      rootConversationId: `sess_${crypto.randomUUID()}`,
    },
  };
}

// --------------------------------------------------- response decoding

/** AWS event-stream framing. CRCs skipped; TLS already guarantees integrity. */
async function* frames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; payload: string }> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= 16) {
      const total = buffer.readUInt32BE(0);
      if (total < 16 || buffer.length < total) break;
      const headerEnd = 12 + buffer.readUInt32BE(4);
      const parsed: Record<string, string> = {};
      let offset = 12;
      while (offset < headerEnd) {
        const nameLength = buffer.readUInt8(offset);
        offset += 1;
        const name = buffer.toString("utf8", offset, offset + nameLength);
        offset += nameLength;
        const valueType = buffer.readUInt8(offset);
        offset += 1;
        if (valueType !== 7) break; // only string headers matter here
        const valueLength = buffer.readUInt16BE(offset);
        offset += 2;
        parsed[name] = buffer.toString("utf8", offset, offset + valueLength);
        offset += valueLength;
      }
      yield {
        type: parsed[":event-type"] ?? parsed[":exception-type"] ?? parsed[":message-type"] ?? "unknown",
        payload: buffer.toString("utf8", headerEnd, total - 4),
      };
      buffer = buffer.subarray(total);
    }
  }
}

const OPEN = "<thinking>";
const CLOSE = "</thinking>";

/**
 * Splits inline <thinking> regions out of the text channel, streaming-safe
 * across chunk boundaries. Needed for the Claude 4.5/4.6 generation, which
 * emits reasoning as literal tags in response to the prompt directive.
 */
class ThinkingTagSplitter {
  private buffer = "";
  private open = false;

  /** How much of the buffer can be emitted without risking a split tag. */
  private safeLength(): number {
    const index = this.buffer.lastIndexOf("<");
    if (index === -1) return this.buffer.length;
    return this.buffer.length - index >= CLOSE.length ? this.buffer.length : index;
  }

  feed(chunk: string): { kind: "text" | "thinking"; text: string }[] {
    this.buffer += chunk;
    const out: { kind: "text" | "thinking"; text: string }[] = [];
    for (;;) {
      const kind = this.open ? "thinking" : "text";
      const marker = this.open ? CLOSE : OPEN;
      const at = this.buffer.indexOf(marker);
      if (at === -1) {
        const safe = this.safeLength();
        if (safe > 0) out.push({ kind, text: this.buffer.slice(0, safe) });
        this.buffer = this.buffer.slice(safe);
        break;
      }
      if (at > 0) out.push({ kind, text: this.buffer.slice(0, at) });
      this.buffer = this.buffer.slice(at + marker.length);
      this.open = !this.open;
    }
    return out;
  }

  flush(): { kind: "text" | "thinking"; text: string }[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? [{ kind: this.open ? "thinking" : "text", text: rest }] : [];
  }
}

/**
 * Suppresses GPT's "..." reasoning placeholder, but only until real reasoning
 * starts: after that, "." and "\n\n" are real deltas (AGENTS.md, "Dropped
 * reasoning punctuation"). Returns the text to emit, or null to suppress.
 */
function reasoningFilter(): (text: string) => string | null {
  let sawReal = false;
  return (text) => {
    if (!sawReal && /^[.\s]*$/.test(text)) return null;
    sawReal = true;
    return text;
  };
}

const STOP_REASONS: Record<string, AssistantMessage["stopReason"]> = {
  END_TURN: "stop",
  TOOL_USE: "toolUse",
  MAX_TOKENS: "length",
};

function streamKiro(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      // Every registered model is in CATALOGUE, so this cannot miss.
      const info = CATALOGUE.get(model.id)!;
      const request = buildRequest(context, info, options?.reasoning);
      const body = JSON.stringify((await options?.onPayload?.(request, model)) ?? request);
      const response = await fetch(RUNTIME, {
        method: "POST",
        headers: rpcHeaders("KiroRuntimeService.GenerateAssistantResponse", options?.apiKey),
        body,
        signal: options?.signal,
      });
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Kiro ${response.status}: ${detail.slice(0, 500) || response.statusText}`);
      }

      output.usage.input = Math.ceil(body.length / 4); // replaced by contextUsageEvent when it arrives

      let textIndex: number | null = null;
      let toolIndex: number | null = null;
      let thinkingIndex: number | null = null;
      // Kiro sends the reasoning signature on its own trailing event, after the
      // last text delta and sometimes after the block has already been closed,
      // so the block has to stay reachable by reference, not by index.
      let thinkingBlock: ThinkingContent | null = null;
      let toolJson = "";
      let contextTokens: number | null = null;
      let credits: number | null = null;
      const splitter = new ThinkingTagSplitter();
      const keepReasoning = reasoningFilter();

      const endText = () => {
        if (textIndex === null) return;
        const block = output.content[textIndex] as { text: string };
        stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
        textIndex = null;
      };
      const endTool = () => {
        if (toolIndex === null) return;
        const block = output.content[toolIndex] as ToolCall;
        stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall: block, partial: output });
        toolIndex = null;
        toolJson = "";
      };
      const endThinking = () => {
        if (thinkingIndex === null) return;
        const block = output.content[thinkingIndex] as { thinking: string };
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: block.thinking,
          partial: output,
        });
        thinkingIndex = null;
      };

      const emitThinking = (delta: string) => {
        if (!delta) return;
        endText();
        endTool();
        if (thinkingIndex === null) {
          const block: ThinkingContent = { type: "thinking", thinking: "" };
          output.content.push(block);
          thinkingIndex = output.content.length - 1;
          thinkingBlock = block;
          stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
        }
        (output.content[thinkingIndex] as { thinking: string }).thinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
      };

      const emitText = (delta: string) => {
        if (!delta) return;
        endTool();
        endThinking();
        if (textIndex === null) {
          output.content.push({ type: "text", text: "" });
          textIndex = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
        }
        (output.content[textIndex] as { text: string }).text += delta;
        stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
      };

      for await (const frame of frames(response.body)) {
        const event = JSON.parse(frame.payload || "{}");
        await options?.onProviderStreamEvent?.({ [frame.type]: event }, model);

        // Native streamed reasoning (Claude 4.7+/5 with thinking.display=summarized).
        if (frame.type === "reasoningContentEvent") {
          const text = keepReasoning(event.text ?? "");
          if (text !== null) emitThinking(text);
          // The signature IS the reasoning for models that withhold the summary
          // (signature-only, or GPT's "..."), so it gets a block even with nothing
          // to display; pi keeps signed blocks. Never attach via emitThinking: it
          // returns early on an empty delta and would drop every signature.
          if (event.signature) {
            if (!thinkingBlock) {
              thinkingBlock = { type: "thinking", thinking: "" };
              output.content.push(thinkingBlock);
            }
            thinkingBlock.thinkingSignature = event.signature;
          }
          continue;
        }

        if (frame.type === "assistantResponseEvent") {
          for (const piece of splitter.feed(event.content ?? "")) {
            if (piece.kind === "thinking") emitThinking(piece.text);
            else emitText(piece.text);
          }
          continue;
        }

        if (frame.type === "toolUseEvent") {
          endText();
          endThinking();
          if (toolIndex === null) {
            output.content.push({ type: "toolCall", id: event.toolUseId, name: event.name, arguments: {} });
            toolIndex = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
          }
          if (event.input) {
            toolJson += event.input;
            (output.content[toolIndex] as ToolCall).arguments = parseStreamingJson<ToolCall["arguments"]>(toolJson);
            stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: event.input, partial: output });
          }
          if (event.stop) endTool();
          continue;
        }

        // Exact context accounting, far better than guessing from string length.
        if (frame.type === "contextUsageEvent") {
          const percent = event.contextUsagePercentage;
          if (typeof percent === "number" && info.contextWindow) {
            contextTokens = Math.round((percent / 100) * info.contextWindow);
          }
          continue;
        }

        // Real billed cost for this request, in Kiro credits.
        if (frame.type === "meteringEvent") {
          if (typeof event.usage === "number") {
            credits = event.usage;
            usage.used += event.usage; // keeps the footer live without another RPC
          }
          continue;
        }

        if (frame.type === "metadataEvent") {
          if (event.stopReason) output.stopReason = STOP_REASONS[event.stopReason] ?? "stop";
          continue;
        }

        if (/exception|error/i.test(frame.type)) {
          throw new Error(`Kiro ${frame.type}: ${event.message ?? frame.payload}`);
        }
      }

      for (const piece of splitter.flush()) {
        if (piece.kind === "thinking") emitThinking(piece.text);
        else emitText(piece.text);
      }
      endText();
      endTool();
      endThinking();
      if (output.stopReason === "pending") {
        output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
      }

      // ponytail: output tokens are a ~4-chars-per-token estimate; the API reports
      // credits, not tokens. Input tokens come from contextUsageEvent and are exact.
      output.usage.output = estimateTokens(output);
      if (contextTokens !== null) output.usage.input = Math.max(0, contextTokens - output.usage.output);
      output.usage.totalTokens = output.usage.input + output.usage.output;

      // Cost is billed in credits, not tokens, so pi's per-token model can't
      // express it — set the resolved dollar figure directly.
      if (credits !== null) {
        const total = credits * USD_PER_CREDIT;
        output.usage.cost = { input: 0, output: total, cacheRead: 0, cacheWrite: 0, total };
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ------------------------------------------------------------ register

const CATALOGUE = new Map<string, KiroModelInfo>();

/**
 * Invariant checks for the non-obvious logic here (AGENTS.md, "The tool-result
 * ordering bug" lists what they catch). Run:  KIRO_SELFTEST=1 pi --list-models kiro
 */
function selfCheck(): void {
  // The ordering bug merged consecutive assistant turns into one, which still
  // "pairs" calls with results but implies the model issued t2 already knowing
  // t1's result. So check the turn shape, not just the ids.
  const entries = buildEntries(
    [
      { role: "user", content: "check" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "ps", arguments: {} }] },
      { role: "toolResult", toolCallId: "t1", content: "stale", isError: false },
      { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "ps", arguments: {} }] },
      { role: "toolResult", toolCallId: "t2", content: "fresh", isError: false },
    ] as unknown as Message[],
    "m",
    "",
  );
  assert.deepEqual(entries.map(isUser), [true, false, true, false, true], "turns merged or not alternating");
  for (const [i, entry] of entries.entries()) {
    if (isUser(entry) || !entry.assistantResponseMessage.toolUses) continue;
    const results = (entries[i + 1] as UserEntry).userInputMessage.userInputMessageContext.toolResults as { toolUseId: string }[];
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      entry.assistantResponseMessage.toolUses.map((c) => c.toolUseId),
      `results after turn ${i} must match its calls exactly`,
    );
  }
  console.error(`[kiro] selfCheck ok — ${entries.length} entries, tool results correctly paired`);

  // Splitter: feed the same input whole, then one character at a time. Both
  // must yield identical output, which is what "streaming-safe" means.
  const source = "before<thinking>secret</thinking>after";
  const collect = (chunks: string[]) => {
    const splitter = new ThinkingTagSplitter();
    const pieces = [...chunks.flatMap((c) => splitter.feed(c)), ...splitter.flush()].filter((p) => p.text);
    // Streaming splits deltas at arbitrary points, so compare coalesced runs:
    // what must hold is the text per channel and its order, not chunk boundaries.
    const runs: { kind: string; text: string }[] = [];
    for (const piece of pieces) {
      const last = runs[runs.length - 1];
      if (last && last.kind === piece.kind) last.text += piece.text;
      else runs.push({ ...piece });
    }
    return runs.map((r) => `${r.kind}:${r.text}`).join("|");
  };
  const expected = "text:before|thinking:secret|text:after";
  assert.equal(collect([source]), expected, "splitter on a single chunk");
  assert.equal(collect([...source]), expected, "splitter on character-by-character chunks (tag straddles boundaries)");
  console.error(`[kiro] selfCheck ok — splitter stable across chunk boundaries`);

  // Reasoning filter: must swallow GPT's placeholder whole, and must never drop
  // a character once real reasoning has started. These deltas are copied
  // verbatim off the wire — punctuation really does arrive on its own.
  const runFilter = (deltas: string[]) => {
    const keep = reasoningFilter();
    return deltas.map(keep).filter((t): t is string => t !== null).join("");
  };
  assert.equal(runFilter(["...", "..."]), "", "GPT placeholder should be suppressed");
  const wire = ["Insertion", " sort", " wins", ".\n\n", "Timsort", " ", "is", " adaptive", "."];
  assert.equal(runFilter(wire), wire.join(""), "reasoning filter dropped characters");
  console.error(`[kiro] selfCheck ok — reasoning filter lossless after first real delta`);

  // Images ride on the user turn as Kiro ImageBlocks: jpg→jpeg, unknown formats dropped.
  const imageEntries = buildEntries(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", mimeType: "image/png", data: "REAL" },
          { type: "image", mimeType: "image/jpg", data: "JPG" },
          { type: "image", mimeType: "image/bmp", data: "DROPME" },
        ],
      },
    ] as unknown as Message[],
    "m",
    "",
  );
  assert.deepEqual(
    (imageEntries[0] as UserEntry).userInputMessage.images,
    [
      { format: "png", source: { bytes: "REAL" } },
      { format: "jpeg", source: { bytes: "JPG" } },
    ],
    "image mapping",
  );
  console.error(`[kiro] selfCheck ok — images map to ImageBlock, jpg→jpeg, unsupported dropped`);

  // A tool that returns an image (pi's `read` on a .png) must not vanish:
  // Kiro tool results carry no image member, so the image is hoisted onto the
  // user turn that carries the results, and the result text says so.
  const toolImageEntries = buildEntries(
    [
      { role: "user", content: "look at the screenshot" },
      { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "r1", content: [{ type: "image", mimeType: "image/png", data: "SHOT" }], isError: false },
    ] as unknown as Message[],
    "m",
    "",
  );
  const carrier = toolImageEntries.find(
    (e) => isUser(e) && !!e.userInputMessage.userInputMessageContext.toolResults,
  ) as UserEntry | undefined;
  assert.deepEqual(carrier?.userInputMessage.images, [{ format: "png", source: { bytes: "SHOT" } }], "tool-result image not hoisted");
  assert.match(JSON.stringify(carrier?.userInputMessage.userInputMessageContext.toolResults), /image\(s\) from this tool/);
  // Image-less models (qwen) must not receive them at all — it 400s the request.
  const blocked = buildEntries(
    [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "NOPE" }] }] as unknown as Message[],
    "m",
    "",
    false,
  );
  assert.equal((blocked[0] as UserEntry).userInputMessage.images, undefined, "images sent to a model that cannot accept them");
  console.error(`[kiro] selfCheck ok — tool-result images hoisted to the user turn, blocked when unsupported`);

  // Over the request-wide image cap, the NEWEST images must survive.
  const image = (data: string) => ({ type: "image", mimeType: "image/png", data });
  const capped = buildEntries(
    [
      { role: "user", content: [image("OLD")] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [image("A"), image("B"), image("C")] },
    ] as unknown as Message[],
    "m",
    "",
  );
  capImages(capped, 2);
  const survivors = capped.filter(isUser).flatMap((e) => (e.userInputMessage.images ?? []) as { source: { bytes: string } }[]);
  assert.deepEqual(survivors.map((i) => i.source.bytes), ["B", "C"], "image cap should keep the newest 2");
  console.error(`[kiro] selfCheck ok — oldest images dropped at the ${MAX_IMAGES}-image request limit`);

  // Reasoning echo. Signed reasoning must go back (or an agentic loop forgets
  // what it already worked out); unsigned reasoning must NOT (Kiro rejects the
  // whole request with `thinking.signature: Field required`).
  const reasoningEntries = buildEntries(
    [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed thought", thinkingSignature: "SIG" },
          { type: "toolCall", id: "t1", name: "read", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "done", isError: false },
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned thought" }, { type: "text", text: "hi" }] },
    ] as unknown as Message[],
    "m",
    "",
  );
  const assistants = reasoningEntries.filter((e) => !isUser(e)) as AssistantEntry[];
  assert.deepEqual(
    assistants[0]?.assistantResponseMessage.reasoningContent?.reasoningText,
    { text: "signed thought", signature: "SIG" },
    "signed reasoning not echoed",
  );
  assert.equal(
    assistants[1]?.assistantResponseMessage.reasoningContent,
    undefined,
    "unsigned reasoning echoed — Kiro 400s the whole request",
  );
  // claude-sonnet-5 and every gpt-5.6-* withhold the summary: the block arrives
  // with empty or "..." text and a real signature. Requiring non-empty text here
  // would silently exclude exactly the models that need this most.
  const silent = buildEntries(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: "SIG5" }, { type: "text", text: "answer" }] },
    ] as unknown as Message[],
    "m",
    "",
  );
  const silentEcho = (silent[1] as AssistantEntry).assistantResponseMessage.reasoningContent?.reasoningText;
  assert.equal(silentEcho?.signature, "SIG5", "signature-only reasoning dropped");
  console.error(`[kiro] selfCheck ok — signed reasoning echoed back (incl. signature-only), unsigned never is`);

  // Transcript replay (pi 0.86+). The prompt and tools live in system messages,
  // and later ones patch them. Hand-rolling this replay is what broke on the
  // 0.86 upgrade — a naive content concatenation also silently drops `sections`.
  const tool = (name: string) => ({ name, description: name, parameters: { type: "object" } });
  const request = buildRequest(
    {
      messages: [
        { role: "system", content: "BASE", sections: { s: "SECTION" }, toolsAdded: [tool("keep"), tool("drop")] },
        { role: "user", content: "go" },
        { role: "system", content: "LATER", sections: { s: "PATCHED" }, toolsRemoved: [{ name: "drop" }], toolsAdded: [tool("added")] },
        { role: "user", content: "again" },
      ],
    } as unknown as TranscriptContext,
    parseModel({ modelId: "m" }),
    undefined,
  );
  const { history, currentMessage } = request.conversationState;
  assert.ok([...history, currentMessage].every(isUser), "a system message became an assistant turn");
  const prompt = ([...history, currentMessage][0] as UserEntry).userInputMessage.content;
  for (const want of ["BASE", "LATER", "PATCHED"]) assert.ok(prompt.includes(want), `replayed prompt is missing ${want}`);
  assert.ok(!prompt.includes("SECTION"), "superseded section still in the prompt");
  const sent = (currentMessage.userInputMessage.userInputMessageContext.tools ?? []) as { toolSpecification: { name: string } }[];
  assert.deepEqual(sent.map((t) => t.toolSpecification.name).sort(), ["added", "keep"], "tool deltas not replayed");
  console.error(`[kiro] selfCheck ok — system prompt, sections and tool deltas replayed from the transcript`);

  // No level (e.g. branch summaries): never send a thinking type the schema doesn't list.
  const thinkingModel = (types: string[]) =>
    parseModel({ modelId: "m", additionalModelRequestFieldsSchema: { properties: { thinking: { properties: { type: { enum: types } } } } } });
  assert.equal(modelRequestFields(thinkingModel(["adaptive"])), undefined, "sent thinking.disabled to an adaptive-only model");
  assert.deepEqual(modelRequestFields(thinkingModel(["adaptive", "disabled"]))?.thinking, { type: "disabled" }, "dropped thinking.disabled");
  console.error(`[kiro] selfCheck ok — thinking type respects the model's schema enum`);
}

export default async function (pi: ExtensionAPI) {
  // `pi --list-models` swallows extension load errors, so print before rethrowing.
  if (process.env.KIRO_SELFTEST) {
    try {
      selfCheck();
    } catch (error) {
      console.error("[kiro] selfCheck failed:", error);
      throw error;
    }
  }
  // Offline or no key: register no models; pi then starts on another provider's model
  // or shows its no-models message.
  const models: KiroModelInfo[] = await fetchModels().catch(() => []);
  for (const info of models) CATALOGUE.set(info.id, info);

  pi.registerProvider("kiro", {
    name: "Kiro",
    baseUrl: RUNTIME,
    // pi hides the kiro models while this is unset and passes it as options.apiKey.
    apiKey: "$KIRO_API_KEY",
    api: "kiro-generate-assistant-response",
    streamSimple: streamKiro,
    models: models.map((info) => {
      const reasoning = info.nativeThinking || !!info.effortPath || info.promptDirectiveThinking;
      const levels: string[] = info.effortLevels.length ? info.effortLevels : ["low", "medium", "high", "xhigh", "max"];
      // null hides a level from /thinking, and pi clamps the session level to what's left.
      const thinkingLevelMap = Object.fromEntries(
        ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, levels.includes(level) ? level : null]),
      );
      return {
        id: info.id,
        name: info.name,
        reasoning,
        ...(reasoning ? { thinkingLevelMap } : {}),
        input: (info.image ? ["text", "image"] : ["text"]) as ("text" | "image")[],
        // Billing is credit-based; real cost is resolved per-request from the
        // meteringEvent, so these stay zero.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: info.contextWindow,
        maxTokens: info.maxTokens,
      };
    }),
  });

  // Credit balance in the footer. Only while a kiro model is active — someone
  // on another provider does not need their Kiro balance in view.
  const showUsage = (ctx: any) => {
    ctx.ui.setStatus("kiro", ctx.model?.provider === "kiro" ? usageStatus() : undefined);
  };
  pi.on("session_start", async (_event, ctx) => {
    await fetchUsage().catch(() => {}); // offline or no key: just show nothing
    showUsage(ctx);
  });
  pi.on("agent_end", async (_event, ctx) => showUsage(ctx));
  pi.on("model_select", async (_event, ctx) => showUsage(ctx));
}
