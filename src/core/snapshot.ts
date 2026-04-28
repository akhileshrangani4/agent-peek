import Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessage, RawSnapshot, StructuredSnapshot, SummarySnapshot, ToolCall,
} from "./types.js";

export interface ToRawOpts {
  limit?: number;
}

export function toRaw(sessionId: string, messages: RawMessage[], opts: ToRawOpts = {}): RawSnapshot {
  const sliced = opts.limit !== undefined && messages.length > opts.limit
    ? messages.slice(-opts.limit)
    : messages;
  return { mode: "raw", sessionId, messages: sliced };
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
  const key = process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !key) {
    return {
      mode: "summary",
      sessionId,
      summary: "Summary unavailable: no ANTHROPIC_API_KEY set; returning structured snapshot.",
      deltaMessageCount: opts.deltaMessageCount,
      fallback: true,
      structured,
    };
  }
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
  const client = opts.client ?? new Anthropic({ apiKey: key! });
  const model = opts.model ?? process.env.AGENT_PEEK_SUMMARY_MODEL ?? "claude-haiku-4-5";
  const prompt = renderSummaryPrompt(messages);
  let summary: string;
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const block = resp.content?.[0];
    summary = (block && (block as any).type === "text") ? (block as any).text : "(no summary)";
  } catch (e) {
    return {
      mode: "summary",
      sessionId,
      summary: `Summary unavailable: ${(e as Error).message}; returning structured snapshot.`,
      deltaMessageCount: opts.deltaMessageCount,
      fallback: true,
      structured,
    };
  }
  if (cacheId) summaryCache.set(cacheId, { value: summary, expires: Date.now() + ttl });
  return { mode: "summary", sessionId, summary, deltaMessageCount: opts.deltaMessageCount };
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
