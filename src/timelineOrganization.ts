import type { TimelinePrompt } from "./types";

export type TimelineOrganizationMode = "newest" | "session";

export interface TimelineSessionGroup {
  key: string;
  providerId: string;
  providerName: string;
  sessionId: string;
  newestTimestampMs?: number;
  prompts: TimelinePrompt[];
}

export function timelineSessionKey(prompt: TimelinePrompt) {
  return JSON.stringify([prompt.providerId, prompt.sessionId]);
}

export function groupTimelinePrompts(
  prompts: TimelinePrompt[],
): TimelineSessionGroup[] {
  const groups = new Map<
    string,
    Omit<TimelineSessionGroup, "prompts"> & {
      firstSourceIndex: number;
      prompts: Array<{ prompt: TimelinePrompt; sourceIndex: number }>;
    }
  >();

  prompts.forEach((prompt, sourceIndex) => {
    const key = timelineSessionKey(prompt);
    const existing = groups.get(key);
    if (existing) {
      existing.prompts.push({ prompt, sourceIndex });
      if (
        prompt.timestampMs !== undefined &&
        (existing.newestTimestampMs === undefined ||
          prompt.timestampMs > existing.newestTimestampMs)
      ) {
        existing.newestTimestampMs = prompt.timestampMs;
      }
      return;
    }
    groups.set(key, {
      key,
      providerId: prompt.providerId,
      providerName: prompt.providerName,
      sessionId: prompt.sessionId,
      newestTimestampMs: prompt.timestampMs,
      firstSourceIndex: sourceIndex,
      prompts: [{ prompt, sourceIndex }],
    });
  });

  return [...groups.values()]
    .sort((a, b) => {
      if (
        a.newestTimestampMs !== undefined &&
        b.newestTimestampMs !== undefined
      ) {
        return (
          b.newestTimestampMs - a.newestTimestampMs ||
          a.firstSourceIndex - b.firstSourceIndex
        );
      }
      if (a.newestTimestampMs !== undefined) return -1;
      if (b.newestTimestampMs !== undefined) return 1;
      return a.firstSourceIndex - b.firstSourceIndex;
    })
    .map(({ firstSourceIndex: _firstSourceIndex, prompts: entries, ...group }) => ({
      ...group,
      prompts: entries
        .sort((a, b) => {
          if (
            a.prompt.timestampMs !== undefined &&
            b.prompt.timestampMs !== undefined
          ) {
            return (
              a.prompt.timestampMs - b.prompt.timestampMs ||
              a.sourceIndex - b.sourceIndex
            );
          }
          if (a.prompt.timestampMs !== undefined) return -1;
          if (b.prompt.timestampMs !== undefined) return 1;
          return a.sourceIndex - b.sourceIndex;
        })
        .map(({ prompt }) => prompt),
    }));
}
