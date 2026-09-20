import { describe, expect, it } from "vitest";
import { parseCsv } from "./csvFormat";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    expect(parseCsv("name,count\r\nalpha,2\r\nbeta,3\r\n").rows).toEqual([
      ["name", "count"],
      ["alpha", "2"],
      ["beta", "3"],
    ]);
  });

  it("parses quoted commas, escaped quotes, and multiline fields", () => {
    expect(
      parseCsv('name,notes\n"alpha, beta","line 1\nline 2"\nitem,"say ""hi"""')
        .rows,
    ).toEqual([
      ["name", "notes"],
      ["alpha, beta", "line 1\nline 2"],
      ["item", 'say "hi"'],
    ]);
  });

  it("reports an unterminated quoted field", () => {
    const result = parseCsv('name,notes\nitem,"unfinished');

    expect(result.rows).toEqual([
      ["name", "notes"],
      ["item", "unfinished"],
    ]);
    expect(result.warning).toBe(
      "The CSV contains an unterminated quoted field.",
    );
  });
});
