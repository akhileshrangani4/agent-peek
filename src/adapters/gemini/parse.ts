// src/adapters/gemini/parse.ts
import type { RawMessage, ToolCall } from "../../core/types.js";

export interface RawGeminiSession {
  sessionId?: string;
  messages?: RawGeminiMessage[];
  [k: string]: unknown;
}

export interface RawGeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  thoughts?: { subject?: string; description?: string }[];
  toolCalls?: {
    id?: string;
    name?: string;
    args?: unknown;
    result?: {
      functionResponse?: {
        id?: string;
        response?: { output?: string };
      };
    }[];
  }[];
  [k: string]: unknown;
}

export function parseSession(raw: RawGeminiSession): RawMessage[] {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return messages.map(parseMessage).filter((m): m is RawMessage => m !== undefined);
}

export function parseMessage(message: RawGeminiMessage): RawMessage | undefined {
  const timestamp = typeof message.timestamp === "string" ? message.timestamp : undefined;
  const toolCalls = extractToolCalls(message.toolCalls);

  if (message.type === "user") {
    return {
      role: "user",
      text: extractContentText(message.content),
      raw: message,
      timestamp,
    };
  }

  if (message.type === "gemini") {
    return {
      role: "assistant",
      text: extractAssistantText(message),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: message,
      timestamp,
    };
  }

  if (message.type === "info") {
    return {
      role: "system",
      text: extractContentText(message.content),
      raw: message,
      timestamp,
    };
  }

  return undefined;
}

function extractAssistantText(message: RawGeminiMessage): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(message.thoughts)) {
    for (const thought of message.thoughts) {
      const subject = typeof thought.subject === "string" ? thought.subject.trim() : "";
      const description = typeof thought.description === "string" ? thought.description.trim() : "";
      if (subject && description) parts.push(`${subject}: ${description}`);
      else if (subject) parts.push(subject);
      else if (description) parts.push(description);
    }
  }
  const content = extractContentText(message.content);
  if (content) parts.push(content);
  return parts.length ? parts.join("\n") : undefined;
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.length ? parts.join("") : undefined;
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return undefined;
}

function extractToolCalls(calls: RawGeminiMessage["toolCalls"]): ToolCall[] {
  if (!Array.isArray(calls)) return [];
  const out: ToolCall[] = [];
  for (const call of calls) {
    out.push({
      name: typeof call.name === "string" ? call.name : "?",
      input: call.args,
      status: "pending",
    });
    if (!Array.isArray(call.result)) continue;
    for (const result of call.result) {
      const response = result.functionResponse?.response;
      if (!response || typeof response.output !== "string") continue;
      out.push({
        name: "(result)",
        output: response.output,
        status: "completed",
      });
    }
  }
  return out;
}

