export interface ArtifactSource {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  root: string;
  available: boolean;
  isCustom: boolean;
  artifactCount: number;
}

export interface ArtifactEntry {
  relativePath: string;
  absolutePath: string;
  name: string;
  extension?: string;
  jsonFormat?: "json" | "jsonl";
  category: string;
  artifactKind: "document" | "database" | "archive" | "binary" | "image" | "opaque";
  size: number;
  createdAt?: number;
  modifiedAt: number;
  contentTitle: string;
  previewKind: "text" | "markdown" | "json" | "yaml" | "image" | "unsupported";
}

export interface ArtifactPreview {
  kind: ArtifactEntry["previewKind"];
  content?: string;
  dataUrl?: string;
  truncated: boolean;
  warning?: string;
  editable: boolean;
  revision?: string;
}

export interface TimelinePrompt {
  text: string;
  timestampMs?: number;
  timestampInferred: boolean;
  providerId: string;
  providerName: string;
  sessionId: string;
  sourcePath: string;
}

export interface PromptTimeline {
  prompts: TimelinePrompt[];
  scannedFiles: number;
  malformedRecords: number;
  truncated: boolean;
}
