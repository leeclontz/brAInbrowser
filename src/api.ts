import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  ArtifactEntry,
  ArtifactPreview,
  ArtifactSource,
  PromptTimeline,
} from "./types";

export function getSources() {
  return invoke<ArtifactSource[]>("get_sources");
}

export function getPromptTimeline() {
  return invoke<PromptTimeline>("get_prompt_timeline");
}

export function listArtifacts(sourceId: string) {
  return invoke<ArtifactEntry[]>("list_artifacts", { sourceId });
}

export function readPreview(sourceId: string, relativePath: string) {
  return invoke<ArtifactPreview>("read_preview", { sourceId, relativePath });
}

export function saveArtifact(
  sourceId: string,
  relativePath: string,
  expectedRevision: string,
  content: string,
) {
  return invoke<string>("save_artifact", {
    sourceId,
    relativePath,
    expectedRevision,
    content,
  });
}

export function addCustomFolder() {
  return invoke<ArtifactSource | null>("add_custom_folder");
}

export function removeCustomFolder(sourceId: string) {
  return invoke<void>("remove_custom_folder", { sourceId });
}

export function trashArtifact(
  sourceId: string,
  relativePath: string,
  confirmed: boolean,
) {
  return invoke<void>("trash_artifact", {
    sourceId,
    relativePath,
    confirmed,
  });
}

export function exportArtifact(sourceId: string, relativePath: string) {
  return invoke<string | null>("export_artifact", {
    sourceId,
    relativePath,
  });
}

export function openArtifactFolder(absolutePath: string) {
  return revealItemInDir(absolutePath);
}
