import type {
  BriefSnapshot, HandoffSnapshot, RawMessage, RawOrder, RawSnapshot, RawWindowFrom,
  StructuredSnapshot, SummarySnapshot, ToolCall,
} from "./types.js";
import { inferTouchedFiles, inferWritingFiles } from "./coordination.js";

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

export function toStructured(sessionId: string, messages: RawMessage[], cwd?: string): StructuredSnapshot {
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  const lastToolCalls: ToolCall[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.text) lastUserMessage = m.text;
    if (m.role === "assistant" && m.text) lastAssistantMessage = m.text;
    if (m.toolCalls) lastToolCalls.push(...m.toolCalls.filter(isNamedToolCall));
  }
  const pendingToolCalls = computePending(messages);
  const activity = computeActivity(messages, pendingToolCalls);
  const currentTask = inferCurrentTask(messages, lastUserMessage);
  return {
    mode: "structured",
    sessionId,
    messageCount: messages.length,
    lastUserMessage,
    lastAssistantMessage,
    currentTask,
    touchedFiles: inferTouchedFiles(messages, cwd),
    writingFiles: inferWritingFiles(messages, cwd),
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

export function toHandoff(sessionId: string, messages: RawMessage[], cwd?: string): HandoffSnapshot {
  const structured = toStructured(sessionId, messages, cwd);
  const assistantText = messages
    .filter((message) => message.role === "assistant" && message.text)
    .map((message) => message.text!);
  const allText = messages
    .filter((message) => message.text && message.role !== "system")
    .map((message) => message.text!);

  return {
    mode: "handoff",
    sessionId,
    messageCount: messages.length,
    activity: structured.activity,
    currentTask: structured.currentTask,
    lastAssistantMessage: structured.lastAssistantMessage,
    decisions: extractLines(assistantText, /\b(decided|decision|chose|using|implemented|added|changed|fixed|removed)\b/i, 5),
    openQuestions: extractQuestions(allText, 5),
    nextActions: extractLines(assistantText, /\b(next|todo|remaining|follow[- ]?up|need to|will)\b/i, 5),
    touchedFiles: inferTouchedFiles(messages, cwd),
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

function inferCurrentTask(messages: RawMessage[], fallback: string | undefined): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !message.text) continue;
    const candidate = objectiveFromAssistantText(message.text);
    if (candidate) return candidate;
  }
  return objectiveFromUserText(fallback);
}

function objectiveFromAssistantText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return undefined;
  const lines = candidateLines(trimmed);
  const objective = lines.find((line) => (
    isObjectiveLine(line) && !isReviewOrStatusLine(line)
  ));
  return objective ? oneLine(cleanObjectiveLine(objective)).slice(0, 240) : undefined;
}

function objectiveFromUserText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = candidateLines(text);
  const reviewLine = lines.find((line) => /\breview\b.+\b(diff|changes|code|project|uncommitted)\b/i.test(line));
  if (reviewLine) return oneLine(cleanObjectiveLine(reviewLine)).slice(0, 240);
  const actionLine = lines.find((line) => (
    !isSystemPromptLine(line) && !isReviewOrStatusLine(line) && /\b(add|build|fix|implement|update|review|inspect|summarize|test|debug|refactor)\b/i.test(line)
  ));
  if (actionLine) return oneLine(cleanObjectiveLine(actionLine)).slice(0, 240);
  if (text.split(/\r?\n/).filter((line) => line.trim()).length > 2 || text.length > 180) return undefined;
  const simpleLine = lines.find((line) => !isSystemPromptLine(line) && !isReviewOrStatusLine(line));
  return simpleLine ? oneLine(cleanObjectiveLine(simpleLine)).slice(0, 240) : undefined;
}

function candidateLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => cleanObjectiveLine(line))
    .filter((line) => isUsableTaskLine(line));
}

function cleanObjectiveLine(line: string): string {
  return line
    .replace(/^[-*#>\s]+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*+$/g, "")
    .trim();
}

function isUsableTaskLine(line: string): boolean {
  if (!line || line.startsWith("{") || line.startsWith("[") || /[{}[\]]/.test(line)) return false;
  if (/^\d+[.)]\s/.test(line) || /^#{1,6}\s/.test(line)) return false;
  if (/^\*\*?[^*]+?\*\*?$/.test(line)) return false;
  if (/^(if|because|since|while|when|although|maybe|perhaps|other)\b/i.test(line)) return false;
  if (isSystemPromptLine(line) || isReviewOrStatusLine(line)) return false;
  return /\b[A-Za-z]{2,}\b/.test(line);
}

function isObjectiveLine(line: string): boolean {
  return /\b(i(?:'ll| will| am|’ll|’m)|i'm|i’m|next|now|plan|going to|need to|working on|let me|i need to)\b/i.test(line)
    && /\b(add|build|fix|implement|update|review|inspect|summarize|test|debug|refactor|run|check|create|write|wire|use|change|remove|hide|show)\b/i.test(line);
}

function isReviewOrStatusLine(line: string): boolean {
  return /\b(passed|failed|green|reviewer|findings|stdout|stderr|would i use it|what improved|weak|untrustworthy|highest leverage|remove or de-emphasize|should have been|thinking about whether|not sure|might use|residual risk)\b/i.test(line);
}

function isSystemPromptLine(line: string): boolean {
  return /\b(you are claude code|you are an ai|act as|acting as|return findings|do not edit|focus on|answer these sections)\b/i.test(line);
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

function extractLines(values: string[], pattern: RegExp, max: number): string[] {
  const lines: string[] = [];
  for (const value of values) {
    for (const line of splitCandidateLines(value)) {
      if (pattern.test(line)) lines.push(oneLine(line, 220));
    }
  }
  return uniqueStrings(lines).slice(-max);
}

function extractQuestions(values: string[], max: number): string[] {
  const questions: string[] = [];
  for (const value of values) {
    for (const line of splitCandidateLines(value)) {
      if (line.endsWith("?") || /\b(blocked|unclear|need input|open question)\b/i.test(line)) {
        questions.push(oneLine(line, 220));
      }
    }
  }
  return uniqueStrings(questions).slice(-max);
}

function splitCandidateLines(value: string): string[] {
  return value
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function toolNames(tools: ToolCall[]): string[] {
  return [...new Set(tools.map((tool) => tool.name))];
}

function isNamedToolCall(tool: ToolCall): boolean {
  return tool.name !== "(result)";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
