import type {
  RawMessage, RawSnapshot, StructuredSnapshot, ToolCall,
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
