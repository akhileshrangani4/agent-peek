import type {
  BriefSnapshot, RawMessage, RawOrder, RawSnapshot, RawWindowFrom,
  StructuredSnapshot, SummarySnapshot, ToolCall,
} from "./types.js";

export interface ToRawOpts {
  limit?: number;
  offset?: number;
  around?: number;
  from?: RawWindowFrom;
  order?: RawOrder;
}

export function toRaw(sessionId: string, messages: RawMessage[], opts: ToRawOpts = {}): RawSnapshot {
  const total = messages.length;
  const order = opts.order ?? "oldest-first";
  const limit = opts.limit === undefined ? total : Math.max(0, opts.limit);
  const offset = Math.max(0, opts.offset ?? 0);
  let start = 0;
  let end = total;

  if (opts.around !== undefined) {
    const center = clamp(Math.trunc(opts.around) - 1, 0, Math.max(0, total - 1));
    const before = Math.floor(limit / 2);
    start = clamp(center - before, 0, total);
    end = clamp(start + limit, 0, total);
    start = clamp(end - limit, 0, total);
  } else if ((opts.from ?? "end") === "start") {
    start = clamp(offset, 0, total);
    end = clamp(start + limit, 0, total);
  } else {
    end = clamp(total - offset, 0, total);
    start = clamp(end - limit, 0, end);
  }

  const sliced = messages.slice(start, end);
  return {
    mode: "raw",
    sessionId,
    messages: order === "newest-first" ? [...sliced].reverse() : sliced,
    totalMessageCount: total,
    window: { start, end, order },
  };
}

export function toStructured(sessionId: string, messages: RawMessage[]): StructuredSnapshot {
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  const lastToolCalls: ToolCall[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.text) lastUserMessage = m.text;
    if (m.role === "assistant" && m.text) lastAssistantMessage = m.text;
    if (m.toolCalls) lastToolCalls.push(...m.toolCalls);
  }
  const pendingToolCalls = computePending(messages);
  const activity = computeActivity(messages, pendingToolCalls);
  return {
    mode: "structured",
    sessionId,
    messageCount: messages.length,
    lastUserMessage,
    lastAssistantMessage,
    currentTask: lastUserMessage,
    pendingToolCalls,
    lastToolCalls: lastToolCalls.slice(-5),
    activity,
  };
}

export function toBrief(sessionId: string, messages: RawMessage[]): BriefSnapshot {
  const structured = toStructured(sessionId, messages);
  const parts: string[] = [];
  if (structured.currentTask) parts.push(`Task: ${oneLine(structured.currentTask)}`);
  if (structured.lastAssistantMessage) parts.push(`Last assistant: ${oneLine(structured.lastAssistantMessage)}`);
  if (structured.pendingToolCalls.length) {
    parts.push(`Pending tools: ${toolNames(structured.pendingToolCalls).join(", ")}`);
  }
  if (!parts.length) {
    parts.push(messages.length ? "No clear current task found in the transcript." : "No messages found.");
  }
  return {
    mode: "brief",
    sessionId,
    messageCount: structured.messageCount,
    activity: structured.activity,
    brief: parts.join(" "),
    currentTask: structured.currentTask,
    lastAssistantMessage: structured.lastAssistantMessage,
    pendingTools: toolNames(structured.pendingToolCalls),
    recentTools: toolNames(structured.lastToolCalls),
  };
}

function computePending(messages: RawMessage[]): ToolCall[] {
  const pendingByName: ToolCall[] = [];
  let resultsAfter = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") resultsAfter++;
    else if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.status === "pending") {
          if (resultsAfter > 0) resultsAfter--;
          else pendingByName.unshift(tc);
        }
      }
    }
  }
  return pendingByName;
}

function computeActivity(messages: RawMessage[], pending: ToolCall[]): "idle" | "thinking" | "tool-running" {
  if (pending.length > 0) return "tool-running";
  const last = messages[messages.length - 1];
  if (!last) return "idle";
  if (last.role === "assistant") return "thinking";
  return "idle";
}

interface ToSummaryOpts {
  deltaMessageCount: number;
  client?: { messages: { create: (req: any) => Promise<any> } };
  model?: string;
  cacheKey?: string;
  ttlMs?: number;
}

const summaryCache = new Map<string, { value: string; expires: number }>();

export async function toSummary(
  sessionId: string,
  messages: RawMessage[],
  opts: ToSummaryOpts,
): Promise<SummarySnapshot> {
  const structured = toStructured(sessionId, messages);
  const cacheId = opts.cacheKey ? `${sessionId}::${opts.cacheKey}` : undefined;
  const ttl = opts.ttlMs ?? 60_000;
  if (cacheId) {
    const hit = summaryCache.get(cacheId);
    if (hit && hit.expires > Date.now()) {
      return {
        mode: "summary",
        sessionId,
        summary: hit.value,
        deltaMessageCount: opts.deltaMessageCount,
      };
    }
  }

  const provider = opts.client
    ? "anthropic"
    : (process.env.AGENT_PEEK_SUMMARY_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "local"));
  if (provider !== "anthropic") {
    const summary = renderLocalSummary(structured, messages);
    if (cacheId) summaryCache.set(cacheId, { value: summary, expires: Date.now() + ttl });
    return { mode: "summary", sessionId, summary, deltaMessageCount: opts.deltaMessageCount };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !key) {
    const summary = renderLocalSummary(structured, messages);
    if (cacheId) summaryCache.set(cacheId, { value: summary, expires: Date.now() + ttl });
    return { mode: "summary", sessionId, summary, deltaMessageCount: opts.deltaMessageCount };
  }

  try {
    const summary = await summarizeWithAnthropic(messages, opts, key);
    if (cacheId) summaryCache.set(cacheId, { value: summary, expires: Date.now() + ttl });
    return { mode: "summary", sessionId, summary, deltaMessageCount: opts.deltaMessageCount };
  } catch (e) {
    const local = renderLocalSummary(structured, messages);
    return {
      mode: "summary",
      sessionId,
      summary: `LLM summary unavailable: ${(e as Error).message}. ${local}`,
      deltaMessageCount: opts.deltaMessageCount,
      fallback: true,
      structured,
    };
  }
}

async function summarizeWithAnthropic(messages: RawMessage[], opts: ToSummaryOpts, key?: string): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = opts.client ?? new Anthropic({ apiKey: key! });
  const model = opts.model ?? process.env.AGENT_PEEK_SUMMARY_MODEL ?? "claude-haiku-4-5";
  const resp = await client.messages.create({
    model,
    max_tokens: 200,
    messages: [{ role: "user", content: renderSummaryPrompt(messages) }],
  });
  const block = resp.content?.[0];
  return (block && (block as any).type === "text") ? (block as any).text : "(no summary)";
}

function renderLocalSummary(structured: StructuredSnapshot, messages: RawMessage[]): string {
  if (!messages.length) return "No messages found in this session yet.";

  const sentences: string[] = [];
  if (structured.currentTask) {
    sentences.push(`Current task: ${oneLine(structured.currentTask, 220)}.`);
  } else {
    sentences.push("No clear current task was found in the transcript tail.");
  }

  const pending = toolNames(structured.pendingToolCalls);
  if (pending.length) {
    sentences.push(`The agent appears to be waiting on ${plural("tool", pending.length)}: ${pending.join(", ")}.`);
  } else if (structured.activity === "thinking") {
    sentences.push("The latest message is from the assistant, so the session may still be in progress.");
  } else {
    sentences.push("The session looks idle after the latest recorded message.");
  }

  if (structured.lastAssistantMessage) {
    sentences.push(`Last assistant update: ${oneLine(structured.lastAssistantMessage, 220)}.`);
  }

  const recent = toolNames(structured.lastToolCalls);
  if (recent.length) {
    sentences.push(`Recent tools: ${recent.join(", ")}.`);
  }

  return sentences.slice(0, 4).join(" ");
}

function renderSummaryPrompt(messages: RawMessage[]): string {
  const tail = messages.slice(-30);
  const lines: string[] = [
    "You are observing another AI agent's chat. Summarize what the agent is currently doing in 2-3 sentences.",
    "Focus on: current task, recent tool calls, and whether it appears blocked or progressing.",
    "Do not invent details. If the messages are sparse, say so.",
    "",
    "--- transcript tail ---",
  ];
  for (const m of tail) {
    if (m.text) lines.push(`[${m.role}] ${m.text}`);
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        lines.push(`[${m.role}] tool=${tc.name} status=${tc.status ?? "?"}`);
      }
    }
  }
  lines.push("--- end ---");
  return lines.join("\n");
}

function toolNames(tools: ToolCall[]): string[] {
  return [...new Set(tools.map((tool) => tool.name))];
}

function oneLine(value: string, max = 180): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}...` : flat;
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
