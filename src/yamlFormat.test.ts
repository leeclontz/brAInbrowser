import { describe, expect, it } from "vitest";
import { formatYamlContent } from "./yamlFormat";

describe("formatYamlContent", () => {
  it("normalizes nested YAML with two-space indentation", () => {
    const result = formatYamlContent(
      "app:\n    name: BrAIn Browser\n    offline: true\nitems:\n - one\n - two\n",
    );

    expect(result.warning).toBeUndefined();
    expect(result.text).toContain("app:\n  name: BrAIn Browser\n  offline: true");
    expect(result.text).toContain("items:\n  - one\n  - two");
  });

  it("preserves comments while formatting", () => {
    const result = formatYamlContent(
      "# application settings\nname: BrAIn Browser # product name\n",
    );

    expect(result.warning).toBeUndefined();
    expect(result.text).toContain("# application settings");
    expect(result.text).toContain("# product name");
  });

  it("formats and separates multiple YAML documents", () => {
    const result = formatYamlContent("name: first\n---\nname: second\n");

    expect(result.warning).toBeUndefined();
    expect(result.documentCount).toBe(2);
    expect(result.text).toContain("name: first\n---\nname: second");
  });

  it("preserves malformed YAML exactly with a warning", () => {
    const source = "name: valid\n  broken: indentation\n";
    const result = formatYamlContent(source);

    expect(result.text).toBe(source);
    expect(result.warning).toMatch(/^Unable to format YAML:/);
  });

  it("does not execute or transform custom tags", () => {
    const source = "value: !!js/function 'function () { return 1 }'\n";
    const result = formatYamlContent(source);

    expect(result.text).toContain("!!js/function");
    expect(result.text).toContain("function () { return 1 }");
  });
});
