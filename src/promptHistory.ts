export interface PromptHistoryEntry {
  text: string;
  timestamp?: number;
  sessionId?: string;
  sourceLine: number;
}

export interface PromptHistoryResult {
  prompts: PromptHistoryEntry[];
  parsedRecords: number;
  parseErrors: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function promptTextValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(promptTextValue)
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;

  const blockType =
    typeof record.type === "string" ? record.type.toLocaleLowerCase() : undefined;
  if (blockType && blockType !== "text" && blockType !== "input_text") {
    return undefined;
  }
  return promptTextValue(record.text ?? record.content);
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) {
    return timestampValue(Number(value));
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractPrompt(record: JsonRecord, sourceLine: number) {
  const message = asRecord(record.message);
  const data = asRecord(record.data);
  const payload = asRecord(record.payload);
  const event = asRecord(record.event);
  const candidates = [record, message, data, payload, event].filter(
    (value): value is JsonRecord => Boolean(value),
  );

  const roleSignals = candidates
    .flatMap((candidate) => [
      candidate.role,
      candidate.type,
      candidate.kind,
      candidate.event_type,
      candidate.eventType,
    ])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLocaleLowerCase());
  const isUserRecord = roleSignals.some(
    (value) =>
      value === "user" ||
      value === "human" ||
      value === "user.message" ||
      value === "user_message" ||
      value.includes("user-message"),
  );
  const isNonUserRecord = roleSignals.some(
    (value) =>
      value === "assistant" ||
      value === "model" ||
      value === "tool" ||
      value === "system" ||
      value === "function" ||
      value.startsWith("assistant.") ||
      value.startsWith("tool.") ||
      value.startsWith("system.") ||
      value.includes("tool-result") ||
      value.includes("tool_result") ||
      value.includes("execution"),
  );
  const isCodexHistory =
    typeof record.text === "string" &&
    (record.session_id !== undefined || record.sessionId !== undefined) &&
    (record.ts !== undefined || record.timestamp !== undefined);
  if (isNonUserRecord && !isUserRecord) return undefined;
  const unambiguousText = promptTextValue(
    record.user_message ?? record.userMessage,
  );
  const userRoleText = isUserRecord
    ? promptTextValue(
        record.user_content ??
          record.userContent ??
          record.prompt ??
          message?.content ??
          message?.text ??
          record.content ??
          record.text ??
          data?.content ??
          data?.text ??
          payload?.content ??
          payload?.text,
      )
    : undefined;
  const text =
    unambiguousText ??
    userRoleText ??
    (isCodexHistory ? promptTextValue(record.text) : undefined);
  if (!text?.trim()) return undefined;

  const timestamp = candidates
    .flatMap((candidate) => [
      candidate.timestamp,
      candidate.ts,
      candidate.created_at,
      candidate.createdAt,
      candidate.time,
    ])
    .map(timestampValue)
    .find((value) => value !== undefined);
  const sessionId = candidates
    .flatMap((candidate) => [
      candidate.session_id,
      candidate.sessionId,
      candidate.conversation_id,
      candidate.conversationId,
      candidate.thread_id,
      candidate.threadId,
    ])
    .map(stringValue)
    .find((value) => value !== undefined);

  return {
    text: text.trim(),
    timestamp,
    sessionId,
    sourceLine,
  } satisfies PromptHistoryEntry;
}

export function extractPromptHistory(source: string): PromptHistoryResult {
  const prompts: PromptHistoryEntry[] = [];
  let parsedRecords = 0;
  let parseErrors = 0;

  source.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = asRecord(JSON.parse(line));
      if (!record) return;
      parsedRecords += 1;
      const prompt = extractPrompt(record, index + 1);
      if (prompt) prompts.push(prompt);
    } catch {
      parseErrors += 1;
    }
  });

  prompts.sort((a, b) => {
    if (a.timestamp !== undefined && b.timestamp !== undefined) {
      return b.timestamp - a.timestamp || b.sourceLine - a.sourceLine;
    }
    if (a.timestamp !== undefined) return -1;
    if (b.timestamp !== undefined) return 1;
    return b.sourceLine - a.sourceLine;
  });

  return { prompts, parsedRecords, parseErrors };
}
