import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIDE_EMPTY_FILES,
  DEFAULT_HIDE_NON_TEXT_FILES,
  filterArtifacts,
} from "./artifactFilters";
import type { ArtifactEntry } from "./types";

function artifact(
  name: string,
  size: number,
  previewKind: ArtifactEntry["previewKind"] = "text",
): ArtifactEntry {
  const extension = name.includes(".") ? name.split(".").pop() : undefined;
  return {
    relativePath: name,
    absolutePath: `C:\\artifacts\\${name}`,
    name,
    extension,
    category: "Other",
    artifactKind: "document",
    size,
    modifiedAt: 0,
    contentTitle: name,
    previewKind,
  };
}

describe("filterArtifacts", () => {
  const artifacts = [
    artifact("empty.txt", 0),
    artifact("content.txt", 1),
    artifact("session.jsonl", 1, "json"),
    artifact("notes.md", 1, "markdown"),
    artifact("config.yaml", 1, "yaml"),
    artifact("script.py", 1),
    artifact("cache.db", 1, "unsupported"),
    artifact("screen.png", 1, "image"),
  ];

  it("hides zero-byte files by default", () => {
    expect(DEFAULT_HIDE_EMPTY_FILES).toBe(true);
    expect(
      filterArtifacts(artifacts, DEFAULT_HIDE_EMPTY_FILES, false).map(
        (entry) => entry.name,
      ),
    ).not.toContain("empty.txt");
  });

  it("shows zero-byte files when the filter is disabled", () => {
    expect(filterArtifacts(artifacts, false, false)).toEqual(artifacts);
  });

  it("hides non-text and Python files by default", () => {
    expect(DEFAULT_HIDE_NON_TEXT_FILES).toBe(true);
    expect(
      filterArtifacts(artifacts, false, DEFAULT_HIDE_NON_TEXT_FILES).map(
        (entry) => entry.name,
      ),
    ).toEqual([
      "empty.txt",
      "content.txt",
      "session.jsonl",
      "notes.md",
      "config.yaml",
    ]);
  });

  it("shows non-text files when the filter is disabled", () => {
    expect(filterArtifacts(artifacts, false, false)).toEqual(artifacts);
  });

  it("composes the empty and non-text filters", () => {
    expect(
      filterArtifacts(artifacts, true, true).map((entry) => entry.name),
    ).toEqual(["content.txt", "session.jsonl", "notes.md", "config.yaml"]);
  });
});
