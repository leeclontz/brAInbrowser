import { describe, expect, it } from "vitest";
import { formatJsonContent } from "./jsonFormat";

describe("formatJsonContent", () => {
  it("pretty-prints nested JSON with two-space indentation", () => {
    const result = formatJsonContent(
      '{"name":"BrAIn Browser","settings":{"offline":true},"items":[1,null]}',
      "json",
    );

    expect(result.warning).toBeUndefined();
    expect(result.text).toBe(
      [
        "{",
        '  "name": "BrAIn Browser",',
        '  "settings": {',
        '    "offline": true',
        "  },",
        '  "items": [',
        "    1,",
        "    null",
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  it("pretty-prints JSON primitives", () => {
    expect(formatJsonContent("true", "json").text).toBe("true");
    expect(formatJsonContent('"hello"', "json").text).toBe('"hello"');
  });

  it("formats each non-empty JSONL record independently", () => {
    const result = formatJsonContent(
      '{"event":"start"}\n\n{"event":"finish","ok":true}',
      "jsonl",
    );

    expect(result.warning).toBeUndefined();
    expect(result.recordCount).toBe(2);
    expect(result.text).toContain('{\n  "event": "start"\n}');
    expect(result.text).toContain(
      '{\n  "event": "finish",\n  "ok": true\n}',
    );
  });

  it("preserves malformed JSON exactly and reports a warning", () => {
    const source = '{"unfinished": true';
    const result = formatJsonContent(source, "json");

    expect(result.text).toBe(source);
    expect(result.warning).toMatch(/^Unable to format JSON:/);
  });

  it("preserves all JSONL when one record is malformed", () => {
    const source = '{"valid":true}\n{"broken":}\n{"alsoValid":true}';
    const result = formatJsonContent(source, "jsonl");

    expect(result.text).toBe(source);
    expect(result.warning).toContain("record 2");
  });

  it("leaves script-like strings as inert JSON text", () => {
    const result = formatJsonContent(
      '{"content":"<script>alert(1)</script>"}',
      "json",
    );

    expect(result.text).toContain("<script>alert(1)</script>");
  });
});
