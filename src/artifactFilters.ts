import type { ArtifactEntry } from "./types";

export const DEFAULT_HIDE_EMPTY_FILES = true;
export const DEFAULT_HIDE_NON_TEXT_FILES = true;

const TEXT_PREVIEW_KINDS = new Set<ArtifactEntry["previewKind"]>([
  "text",
  "markdown",
  "json",
  "yaml",
]);

export function filterArtifacts(
  artifacts: ArtifactEntry[],
  hideEmptyFiles: boolean,
  hideNonTextFiles: boolean,
) {
  return artifacts.filter(
    (artifact) =>
      (!hideEmptyFiles || artifact.size !== 0) &&
      (!hideNonTextFiles ||
        (TEXT_PREVIEW_KINDS.has(artifact.previewKind) &&
          artifact.extension?.toLocaleLowerCase() !== "py")),
  );
}
