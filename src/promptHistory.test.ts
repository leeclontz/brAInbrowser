import { describe, expect, it } from "vitest";
import { extractPromptHistory } from "./promptHistory";

describe("extractPromptHistory", () => {
  it("extracts Codex history records newest first", () => {
    const result = extractPromptHistory(
      [
        '{"session_id":"a","ts":100,"text":"first"}',
        '{"session_id":"a","ts":200,"text":"second"}',
      ].join("\n"),
    );

    expect(result.prompts.map((prompt) => prompt.text)).toEqual([
      "second",
      "first",
    ]);
    expect(result.prompts[0].timestamp).toBe(200_000);
  });

  it("extracts Claude content blocks", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-12T10:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Explain this code" },
            { type: "text", text: "Focus on security" },
          ],
        },
      }),
    );

    expect(result.prompts[0].text).toBe(
      "Explain this code\nFocus on security",
    );
  });

  it("extracts Copilot-style user message events", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "user.message",
        timestamp: "2026-09-12T11:00:00Z",
        user_content: "Build the feature",
      }),
    );

    expect(result.prompts[0].text).toBe("Build the feature");
  });

  it("ignores assistant events", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Done" },
      }),
    );

    expect(result.prompts).toHaveLength(0);
  });

  it("ignores tool events even when they carry user_content", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "tool.execution_complete",
        user_content:
          "12583 INFO: Copying 0 resources to EXE\n13220 INFO: Build complete!",
      }),
    );

    expect(result.prompts).toHaveLength(0);
  });

  it("ignores assistant events even when they carry user_message context", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "assistant.message",
        user_message: "Context copied onto an assistant event",
        assistant_content: "Response",
      }),
    );

    expect(result.prompts).toHaveLength(0);
  });

  it("ignores Claude tool results that use the user protocol role", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content:
                "21: from webview.menu import Menu, MenuAction, MenuSeparator\n273:             if window.menu or _state['menu']:",
            },
          ],
        },
      }),
    );

    expect(result.prompts).toHaveLength(0);
  });

  it("keeps Claude text blocks while omitting adjacent tool results", () => {
    const result = extractPromptHistory(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "internal command output",
            },
            { type: "text", text: "Now explain the menu implementation" },
          ],
        },
      }),
    );

    expect(result.prompts.map((prompt) => prompt.text)).toEqual([
      "Now explain the menu implementation",
    ]);
  });

  it("skips malformed lines while retaining valid prompts", () => {
    const result = extractPromptHistory(
      '{"role":"user","content":"valid"}\n{broken',
    );

    expect(result.prompts[0].text).toBe("valid");
    expect(result.parseErrors).toBe(1);
  });

  it("uses reverse source order when timestamps are absent", () => {
    const result = extractPromptHistory(
      '{"role":"user","content":"older"}\n{"role":"user","content":"newer"}',
    );

    expect(result.prompts.map((prompt) => prompt.text)).toEqual([
      "newer",
      "older",
    ]);
  });
});
