import { beforeEach, describe, expect, it, vi } from "vitest";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { openArtifactFolder } from "./api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

describe("openArtifactFolder", () => {
  beforeEach(() => {
    vi.mocked(revealItemInDir).mockReset();
  });

  it("reveals the selected artifact in its native file manager", async () => {
    const absolutePath = "C:\\artifacts\\session.jsonl";

    await openArtifactFolder(absolutePath);

    expect(revealItemInDir).toHaveBeenCalledWith(absolutePath);
  });
});
