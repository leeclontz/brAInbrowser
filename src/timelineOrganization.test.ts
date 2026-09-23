import { describe, expect, it } from "vitest";
import type { TimelinePrompt } from "./types";
import {
  groupTimelinePrompts,
  timelineSessionKey,
} from "./timelineOrganization";

function prompt(
  providerId: string,
  sessionId: string,
  text: string,
  timestampMs?: number,
): TimelinePrompt {
  return {
    text,
    timestampMs,
    timestampInferred: false,
    providerId,
    providerName: providerId,
    sessionId,
    sourcePath: `${providerId}/${sessionId}.jsonl`,
  };
}

describe("timeline organization", () => {
  it("scopes identical session IDs by provider", () => {
    const groups = groupTimelinePrompts([
      prompt("claude-code", "shared", "Claude", 200),
      prompt("copilot", "shared", "Copilot", 100),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key)).toEqual([
      timelineSessionKey(groups[0].prompts[0]),
      timelineSessionKey(groups[1].prompts[0]),
    ]);
  });

  it("orders sessions by newest activity and prompts oldest first", () => {
    const groups = groupTimelinePrompts([
      prompt("copilot", "older-session", "latest there", 300),
      prompt("claude-code", "newer-session", "newest", 500),
      prompt("claude-code", "newer-session", "oldest", 100),
      prompt("copilot", "older-session", "earliest there", 200),
    ]);

    expect(groups.map((group) => group.sessionId)).toEqual([
      "newer-session",
      "older-session",
    ]);
    expect(groups[0].prompts.map((item) => item.text)).toEqual([
      "oldest",
      "newest",
    ]);
    expect(groups[1].prompts.map((item) => item.text)).toEqual([
      "earliest there",
      "latest there",
    ]);
  });

  it("keeps equal and missing timestamps stable", () => {
    const groups = groupTimelinePrompts([
      prompt("copilot", "session", "equal first", 100),
      prompt("copilot", "session", "missing first"),
      prompt("copilot", "session", "equal second", 100),
      prompt("copilot", "session", "missing second"),
    ]);

    expect(groups[0].prompts.map((item) => item.text)).toEqual([
      "equal first",
      "equal second",
      "missing first",
      "missing second",
    ]);
  });

  it("groups only the filtered prompts supplied by the caller", () => {
    const groups = groupTimelinePrompts([
      prompt("copilot", "one", "matching", 200),
      prompt("copilot", "two", "also matching", 100),
    ]);

    expect(groups.map((group) => group.sessionId)).toEqual(["one", "two"]);
    expect(groups.map((group) => group.prompts.length)).toEqual([1, 1]);
  });
});
