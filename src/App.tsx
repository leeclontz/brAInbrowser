import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArchiveRestore,
  Bot,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Database,
  Download,
  FileArchive,
  FileCode2,
  FileImage,
  FileQuestion,
  FileText,
  FolderOpen,
  MessageSquareText,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import "./App.css";
import {
  addCustomFolder,
  exportArtifact,
  getPromptTimeline,
  getSources,
  listArtifacts,
  openArtifactFolder,
  readPreview,
  removeCustomFolder,
  saveArtifact,
  trashArtifact,
} from "./api";
import {
  DEFAULT_HIDE_EMPTY_FILES,
  DEFAULT_HIDE_NON_TEXT_FILES,
  filterArtifacts,
} from "./artifactFilters";
import { PromptTimelineView } from "./PromptTimelineView";
import type {
  ArtifactEntry,
  ArtifactPreview,
  ArtifactSource,
  PromptTimeline,
} from "./types";

const JsonPreview = lazy(() =>
  import("./JsonPreview").then((module) => ({
    default: module.JsonPreview,
  })),
);
const CsvPreview = lazy(() =>
  import("./CsvPreview").then((module) => ({
    default: module.CsvPreview,
  })),
);
const JsonlSessionPreview = lazy(() =>
  import("./JsonlSessionPreview").then((module) => ({
    default: module.JsonlSessionPreview,
  })),
);
const YamlPreview = lazy(() =>
  import("./YamlPreview").then((module) => ({
    default: module.YamlPreview,
  })),
);

const CATEGORY_ORDER = [
  "Plans",
  "Session Logs",
  "Other Session Artifacts",
  "Memories",
  "Agents",
  "Skills",
  "Rules & Instructions",
  "Prompts",
  "MCP Configuration",
  "Extensions & Plugins",
  "Commands & Hooks",
  "Logs",
  "Credentials",
  "Caches",
  "Databases",
  "Configuration",
  "Images",
  "Other",
];
const TIMELINE_SOURCE: ArtifactSource = {
  id: "prompt-timeline",
  providerId: "prompt-timeline",
  providerName: "All AI tools",
  name: "Prompt Timeline",
  root: "",
  available: true,
  isCustom: false,
  artifactCount: 0,
};

type SortMode = "modified" | "name" | "size" | "type";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; value >= 1024 && i < units.length; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatCompactDate(timestamp?: number) {
  if (!timestamp) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp * 1000));
}

function artifactIcon(entry: ArtifactEntry) {
  switch (entry.artifactKind) {
    case "database":
      return <Database size={17} />;
    case "archive":
      return <FileArchive size={17} />;
    case "binary":
      return <Package size={17} />;
    case "image":
      return <FileImage size={17} />;
    case "opaque":
      return <FileQuestion size={17} />;
    default:
      if (["json", "yaml", "markdown"].includes(entry.previewKind)) {
        return <FileCode2 size={17} />;
      }
      return <FileText size={17} />;
  }
}

function artifactTypeLabel(entry: ArtifactEntry) {
  return entry.extension?.toUpperCase() ?? entry.artifactKind.toUpperCase();
}

function artifactRole(entry: ArtifactEntry) {
  const path = entry.relativePath.toLocaleLowerCase();
  if (path.includes("session") || path.includes("conversation") || path.includes("chat")) {
    return "Session or conversation data";
  }
  if (path.includes("memory")) return "AI memory or retrieval data";
  if (path.includes("history")) return "History or activity index";
  if (path.includes("cache") || path.includes("index")) {
    return "Cache or search index";
  }
  if (path.includes("state")) return "Application state store";
  if (entry.category === "MCP Configuration") {
    return "Model Context Protocol server configuration";
  }
  if (entry.artifactKind === "database") return "Structured application data store";
  if (entry.artifactKind === "archive") return "Packaged or compressed application data";
  if (entry.artifactKind === "binary") return "Binary application artifact";
  return "Application-managed artifact";
}

function App() {
  const [sources, setSources] = useState<ArtifactSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [timeline, setTimeline] = useState<PromptTimeline>();
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("modified");
  const [hideEmptyFiles, setHideEmptyFiles] = useState(
    DEFAULT_HIDE_EMPTY_FILES,
  );
  const hideEmptyFilesRef = useRef(DEFAULT_HIDE_EMPTY_FILES);
  const [hideNonTextFiles, setHideNonTextFiles] = useState(
    DEFAULT_HIDE_NON_TEXT_FILES,
  );
  const hideNonTextFilesRef = useRef(DEFAULT_HIDE_NON_TEXT_FILES);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(CATEGORY_ORDER),
  );
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string>();

  const selectedSource = sources.find(
    (source) => source.id === selectedSourceId,
  );
  const visibleArtifacts = useMemo(
    () => filterArtifacts(artifacts, hideEmptyFiles, hideNonTextFiles),
    [artifacts, hideEmptyFiles, hideNonTextFiles],
  );
  const selectedArtifact = visibleArtifacts.find(
    (artifact) => artifact.relativePath === selectedPath,
  );
  const isPromptTimeline = selectedSourceId === TIMELINE_SOURCE.id;
  const dirty =
    Boolean(preview?.editable) &&
    preview?.content !== undefined &&
    draftContent !== preview.content;

  const loadSources = useCallback(async () => {
    setMessage(undefined);
    try {
      const next = [TIMELINE_SOURCE, ...(await getSources())];
      setSources(next);
      setSelectedSourceId((current) => {
        if (current && next.some((source) => source.id === current)) {
          return current;
        }
        return next.find((source) => source.available)?.id ?? next[0]?.id;
      });
    } catch (error) {
      setMessage(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    setMessage(undefined);
    try {
      setTimeline(await getPromptTimeline());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const loadArtifacts = useCallback(async (sourceId: string) => {
    setLoading(true);
    setMessage(undefined);
    try {
      const next = await listArtifacts(sourceId);
      setArtifacts(next);
      const visibleNext = filterArtifacts(
        next,
        hideEmptyFilesRef.current,
        hideNonTextFilesRef.current,
      );
      setSelectedPath((current) =>
        current && visibleNext.some((item) => item.relativePath === current)
          ? current
          : visibleNext[0]?.relativePath,
      );
    } catch (error) {
      setArtifacts([]);
      setSelectedPath(undefined);
      setMessage(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPreview = useCallback(
    async (sourceId: string, relativePath: string) => {
      setMessage(undefined);
      try {
        const next = await readPreview(sourceId, relativePath);
        setPreview(next);
        setDraftContent(next.content ?? "");
        setEditing(false);
      } catch (error) {
        setPreview(undefined);
        setMessage(String(error));
      }
    },
    [],
  );

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    setArtifacts([]);
    setSelectedPath(undefined);
    setPreview(undefined);
    if (selectedSourceId === TIMELINE_SOURCE.id) {
      void loadTimeline();
    } else if (selectedSourceId) {
      void loadArtifacts(selectedSourceId);
    }
  }, [loadArtifacts, loadTimeline, selectedSourceId]);

  useEffect(() => {
    setPreview(undefined);
    if (selectedSourceId && selectedPath) {
      void loadPreview(selectedSourceId, selectedPath);
    }
  }, [loadPreview, selectedPath, selectedSourceId]);

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const groupedArtifacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = normalized
      ? visibleArtifacts.filter((artifact) =>
          `${artifact.name} ${artifact.contentTitle} ${artifact.absolutePath} ${artifact.category} ${artifact.artifactKind} ${artifact.extension ?? ""}`
            .toLocaleLowerCase()
            .includes(normalized),
        )
      : visibleArtifacts;
    const sorted = [...filtered].sort((a, b) => {
      switch (sortMode) {
        case "name":
          return a.name.localeCompare(b.name);
        case "size":
          return b.size - a.size || a.name.localeCompare(b.name);
        case "type":
          return (
            a.artifactKind.localeCompare(b.artifactKind) ||
            (a.extension ?? "").localeCompare(b.extension ?? "") ||
            a.name.localeCompare(b.name)
          );
        default:
          return b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name);
      }
    });
    const groups = new Map<string, ArtifactEntry[]>();
    sorted.forEach((artifact) => {
      const group = groups.get(artifact.category) ?? [];
      group.push(artifact);
      groups.set(artifact.category, group);
    });
    return [...groups.entries()].sort(([a], [b]) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [query, sortMode, visibleArtifacts]);

  function handleHideEmptyFilesChange(checked: boolean) {
    hideEmptyFilesRef.current = checked;
    setHideEmptyFiles(checked);
    if (!checked) return;
    const visibleNext = filterArtifacts(
      artifacts,
      checked,
      hideNonTextFilesRef.current,
    );
    setSelectedPath((current) => {
      if (
        current &&
        visibleNext.some((artifact) => artifact.relativePath === current)
      ) {
        return current;
      }
      return visibleNext[0]?.relativePath;
    });
  }

  function handleHideNonTextFilesChange(checked: boolean) {
    hideNonTextFilesRef.current = checked;
    setHideNonTextFiles(checked);
    if (!checked) return;
    const visibleNext = filterArtifacts(
      artifacts,
      hideEmptyFilesRef.current,
      checked,
    );
    setSelectedPath((current) => {
      if (
        current &&
        visibleNext.some((artifact) => artifact.relativePath === current)
      ) {
        return current;
      }
      return visibleNext[0]?.relativePath;
    });
  }

  async function handleAddFolder() {
    if (!confirmDiscardChanges()) return;
    try {
      const source = await addCustomFolder();
      if (!source) return;
      await loadSources();
      setSelectedSourceId(source.id);
    } catch (error) {
      setMessage(String(error));
    }
  }

  function confirmDiscardChanges() {
    return (
      !dirty || window.confirm("Discard the unsaved changes to this artifact?")
    );
  }

  function handleSelectSource(sourceId: string) {
    if (!confirmDiscardChanges()) return;
    setSelectedSourceId(sourceId);
  }

  function handleSelectArtifact(relativePath: string) {
    if (!confirmDiscardChanges()) return;
    setSelectedPath(relativePath);
  }

  async function handleRemoveSource(source: ArtifactSource) {
    if (source.id === selectedSourceId && !confirmDiscardChanges()) return;
    if (
      !window.confirm(
        `Remove "${source.name}" from BrAIn Browser?\n\nIts files will not be deleted.`,
      )
    ) {
      return;
    }
    try {
      await removeCustomFolder(source.id);
      await loadSources();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleTrash(entry: ArtifactEntry) {
    if (!selectedSourceId) return;
    if (
      !window.confirm(
        `Move "${entry.name}" to the ${
          navigator.platform.toLocaleLowerCase().includes("mac")
            ? "Trash"
            : "Recycle Bin"
        }?\n\n${entry.relativePath}`,
      )
    ) {
      return;
    }
    try {
      await trashArtifact(selectedSourceId, entry.relativePath, true);
      await loadArtifacts(selectedSourceId);
      await loadSources();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleCopy() {
    if (!preview?.content || preview.kind === "image") return;
    try {
      await writeText(editing ? draftContent : preview.content);
      setMessage("Copied artifact contents to the clipboard.");
    } catch {
      setMessage("Clipboard access was denied by the operating system.");
    }
  }

  function handleEditToggle() {
    if (!preview?.editable) return;
    if (editing && dirty && !confirmDiscardChanges()) return;
    if (editing) setDraftContent(preview.content ?? "");
    setEditing((current) => !current);
  }

  async function handleSave() {
    if (
      !dirty ||
      !preview?.revision ||
      !selectedSourceId ||
      !selectedArtifact
    ) {
      return;
    }
    setSaving(true);
    setMessage(undefined);
    try {
      await saveArtifact(
        selectedSourceId,
        selectedArtifact.relativePath,
        preview.revision,
        draftContent,
      );
      await Promise.all([
        loadPreview(selectedSourceId, selectedArtifact.relativePath),
        loadArtifacts(selectedSourceId),
      ]);
      setMessage(`Saved ${selectedArtifact.name}.`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyPath() {
    if (!selectedArtifact) return;
    try {
      await writeText(selectedArtifact.absolutePath);
      setMessage("Copied artifact path to the clipboard.");
    } catch {
      setMessage("Clipboard access was denied by the operating system.");
    }
  }

  async function handleOpenFolder() {
    if (!selectedArtifact) return;
    try {
      await openArtifactFolder(selectedArtifact.absolutePath);
    } catch (error) {
      setMessage(`Could not open the containing folder: ${String(error)}`);
    }
  }

  async function handleExport() {
    if (!selectedSourceId || !selectedArtifact) return;
    try {
      const destination = await exportArtifact(
        selectedSourceId,
        selectedArtifact.relativePath,
      );
      if (destination) setMessage(`Exported to ${destination}`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRefresh() {
    if (!confirmDiscardChanges()) return;
    if (isPromptTimeline) {
      await Promise.all([loadSources(), loadTimeline()]);
      return;
    }
    if (!selectedSourceId) {
      await loadSources();
      return;
    }
    await Promise.all([loadSources(), loadArtifacts(selectedSourceId)]);
    if (selectedPath) await loadPreview(selectedSourceId, selectedPath);
  }

  function renderPreview() {
    if (!selectedArtifact) {
      return (
        <div className="empty-state">
          <ArchiveRestore size={42} strokeWidth={1.4} />
          <h2>Select an artifact</h2>
          <p>Choose a file to inspect exactly what the application stored.</p>
        </div>
      );
    }
    if (!preview) {
      return <div className="preview-loading">Loading preview…</div>;
    }
    if (editing && preview.editable) {
      return (
        <textarea
          className="code-editor"
          value={draftContent}
          onChange={(event) => setDraftContent(event.target.value)}
          aria-label={`Edit ${selectedArtifact.name}`}
          spellCheck={false}
        />
      );
    }
    if (preview.kind === "image" && preview.dataUrl) {
      return (
        <div className="image-preview">
          <img src={preview.dataUrl} alt={selectedArtifact.name} />
        </div>
      );
    }
    if (preview.kind === "markdown" && preview.content !== undefined) {
      return (
        <article className="markdown-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ children, href }) => (
                <span className="markdown-link" title={href}>
                  {children}
                </span>
              ),
            }}
          >
            {preview.content}
          </ReactMarkdown>
        </article>
      );
    }
    if (preview.kind === "json" && preview.content !== undefined) {
      if (selectedArtifact.jsonFormat === "jsonl") {
        return (
          <Suspense
            fallback={<div className="preview-loading">Reading prompt history…</div>}
          >
            <JsonlSessionPreview
              key={selectedArtifact.relativePath}
              content={preview.content}
            />
          </Suspense>
        );
      }
      return (
        <Suspense fallback={<div className="preview-loading">Formatting JSON…</div>}>
          <JsonPreview
            content={preview.content}
            format={selectedArtifact.jsonFormat ?? "json"}
          />
        </Suspense>
      );
    }
    if (preview.kind === "yaml" && preview.content !== undefined) {
      return (
        <Suspense fallback={<div className="preview-loading">Formatting YAML…</div>}>
          <YamlPreview content={preview.content} />
        </Suspense>
      );
    }
    if (
      selectedArtifact.extension?.toLocaleLowerCase() === "csv" &&
      preview.content !== undefined
    ) {
      return (
        <Suspense fallback={<div className="preview-loading">Formatting CSV…</div>}>
          <CsvPreview content={preview.content} />
        </Suspense>
      );
    }
    if (preview.content !== undefined) {
      return <pre className="code-preview">{preview.content}</pre>;
    }
    const TypeIcon =
      selectedArtifact.artifactKind === "database"
        ? Database
        : selectedArtifact.artifactKind === "archive"
          ? FileArchive
          : selectedArtifact.artifactKind === "binary"
            ? Package
            : FileQuestion;
    return (
      <div className="metadata-preview">
        <div className={`metadata-preview-icon kind-${selectedArtifact.artifactKind}`}>
          <TypeIcon size={30} strokeWidth={1.5} />
        </div>
        <span className="eyebrow">{selectedArtifact.artifactKind}</span>
        <h2>{artifactRole(selectedArtifact)}</h2>
        <p>
          {preview.warning ??
            "This artifact is available to inspect as metadata and export unchanged."}
        </p>
        <dl>
          <div>
            <dt>Format</dt>
            <dd>{artifactTypeLabel(selectedArtifact)}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(selectedArtifact.size)}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatCompactDate(selectedArtifact.createdAt)}</dd>
          </div>
          <div>
            <dt>Modified</dt>
            <dd>{formatDate(selectedArtifact.modifiedAt)}</dd>
          </div>
          <div className="metadata-path-row">
            <dt>Location</dt>
            <dd>{selectedArtifact.absolutePath}</dd>
          </div>
        </dl>
        <button className="button subtle" onClick={() => void handleCopyPath()}>
          <Clipboard size={15} /> Copy path
        </button>
      </div>
    );
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <strong>BrAIn Browser</strong>
            <span>Local AI artifact explorer</span>
          </div>
        </div>
        <div className="title-actions">
          <button className="button subtle" onClick={() => void handleAddFolder()}>
            <Plus size={16} /> Add folder
          </button>
          <button
            className="button icon-button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {message && (
        <div className="status-bar" role="status">
          <span>{message}</span>
          <button onClick={() => setMessage(undefined)}>Dismiss</button>
        </div>
      )}

      <div className="workspace">
        <aside className="sources-panel">
          <div className="panel-heading">
            <span>Applications</span>
            <span>
              {
                sources.filter(
                  (source) =>
                    source.available && source.id !== TIMELINE_SOURCE.id,
                ).length
              }
            </span>
          </div>
          <nav aria-label="Artifact sources">
            {sources.map((source) => (
              <button
                key={source.id}
                className={`source-item ${
                  source.id === selectedSourceId ? "selected" : ""
                }`}
                onClick={() => handleSelectSource(source.id)}
                disabled={!source.available}
              >
                <span className={`source-icon provider-${source.providerId}`}>
                  {source.id === TIMELINE_SOURCE.id ? (
                    <MessageSquareText size={19} />
                  ) : source.isCustom ? (
                    <FolderOpen size={19} />
                  ) : (
                    <Bot size={19} />
                  )}
                </span>
                <span className="source-copy">
                  <strong>{source.name}</strong>
                  <small>
                    {source.id === TIMELINE_SOURCE.id
                      ? timeline
                        ? `${timeline.prompts.length} prompt${
                            timeline.prompts.length === 1 ? "" : "s"
                          }`
                        : "All local tools"
                      : source.available
                      ? `${source.artifactCount} artifact${
                          source.artifactCount === 1 ? "" : "s"
                        }`
                      : "Not detected"}
                  </small>
                </span>
                {source.isCustom && (
                  <span
                    className="source-remove"
                    role="button"
                    aria-label={`Remove ${source.name}`}
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleRemoveSource(source);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.stopPropagation();
                        void handleRemoveSource(source);
                      }
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="privacy-note">
            <span className="privacy-dot" />
            Fully local · No telemetry
          </div>
        </aside>

        {isPromptTimeline ? (
          <PromptTimelineView
            timeline={timeline}
            loading={timelineLoading}
            onRefresh={() => void loadTimeline()}
          />
        ) : (
          <>
        <section className="artifacts-panel">
          <div className="artifacts-header">
            <div>
              <span className="eyebrow">{selectedSource?.providerName}</span>
              <h1>{selectedSource?.name ?? "Artifacts"}</h1>
            </div>
            <span className="artifact-total">{visibleArtifacts.length}</span>
          </div>
          <div className="artifact-controls">
            <label className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter artifacts"
                aria-label="Filter artifacts"
              />
            </label>
            <select
              className="sort-select"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              aria-label="Sort artifacts"
            >
              <option value="modified">Newest</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="type">Type</option>
            </select>
            <label className="artifact-filter">
              <input
                type="checkbox"
                checked={hideEmptyFiles}
                onChange={(event) =>
                  handleHideEmptyFilesChange(event.target.checked)
                }
              />
              <span>Hide 0KB files</span>
            </label>
            <label className="artifact-filter">
              <input
                type="checkbox"
                checked={hideNonTextFiles}
                onChange={(event) =>
                  handleHideNonTextFilesChange(event.target.checked)
                }
              />
              <span>Hide non-text and code files</span>
            </label>
          </div>
          <div className="artifact-list">
            {loading && artifacts.length === 0 ? (
              <div className="list-message">Scanning approved folders…</div>
            ) : groupedArtifacts.length === 0 ? (
              <div className="list-message">
                {selectedSource?.available
                  ? "No matching artifacts found."
                  : "This application was not detected."}
              </div>
            ) : (
              groupedArtifacts.map(([category, entries]) => {
                const isCollapsed = collapsed.has(category);
                return (
                  <div className="artifact-group" key={category}>
                    <button
                      className="group-heading"
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(category)) next.delete(category);
                          else next.add(category);
                          return next;
                        })
                      }
                    >
                      {isCollapsed ? (
                        <ChevronRight size={15} />
                      ) : (
                        <ChevronDown size={15} />
                      )}
                      <span>{category}</span>
                      <span>{entries.length}</span>
                    </button>
                    {!isCollapsed &&
                      entries.map((entry) => (
                        <button
                          className={`artifact-item ${
                            entry.relativePath === selectedPath ? "selected" : ""
                          }`}
                          key={entry.relativePath}
                          title={entry.contentTitle}
                          aria-label={`${entry.name}: ${entry.contentTitle}`}
                          onClick={() => handleSelectArtifact(entry.relativePath)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void handleTrash(entry);
                          }}
                        >
                          <span className="file-icon">{artifactIcon(entry)}</span>
                          <span className="artifact-copy">
                            <span className="artifact-name-row">
                              <strong>{entry.name}</strong>
                              <span
                                className={`type-badge kind-${entry.artifactKind}`}
                                title={`${entry.artifactKind} artifact`}
                              >
                                {artifactTypeLabel(entry)}
                              </span>
                            </span>
                            <span className="artifact-dates">
                              <small>
                                <b>Created</b> {formatCompactDate(entry.createdAt)}
                              </small>
                              <small>
                                <b>Modified</b>{" "}
                                {formatCompactDate(entry.modifiedAt)}
                                <i>·</i>
                                {formatBytes(entry.size)}
                              </small>
                            </span>
                          </span>
                          <span
                            className="trash-action"
                            role="button"
                            tabIndex={0}
                            aria-label={`Move ${entry.name} to trash`}
                            title="Move to trash"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleTrash(entry);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.stopPropagation();
                                void handleTrash(entry);
                              }
                            }}
                          >
                            <Trash2 size={15} />
                          </span>
                        </button>
                      ))}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="viewer-panel">
          <div className="viewer-header">
            <div className="viewer-title">
              <span className="eyebrow">
                {selectedArtifact?.category ?? "Preview"}
              </span>
              <h2 title={selectedArtifact?.absolutePath}>
                {selectedArtifact?.name ?? "Artifact viewer"}
              </h2>
              {selectedArtifact && (
                <div className="metadata">
                  <span>{formatBytes(selectedArtifact.size)}</span>
                  <span>
                    Created{" "}
                    {selectedArtifact.createdAt
                      ? formatDate(selectedArtifact.createdAt)
                      : "Unavailable"}
                  </span>
                  <span>Modified {formatDate(selectedArtifact.modifiedAt)}</span>
                  {dirty && <span className="dirty-indicator">Unsaved changes</span>}
                  {preview?.truncated && <span>Preview truncated</span>}
                </div>
              )}
            </div>
            <div className="viewer-actions">
              <button
                className={`button subtle ${editing ? "active" : ""}`}
                disabled={!preview?.editable}
                onClick={handleEditToggle}
              >
                <Pencil size={15} /> {editing ? "Cancel" : "Edit"}
              </button>
              <button
                className={`button save-button ${dirty ? "dirty" : ""}`}
                disabled={!dirty || saving}
                onClick={() => void handleSave()}
              >
                <Save size={15} /> {saving ? "Saving…" : "Save"}
              </button>
              <button
                className="button subtle"
                disabled={!preview?.content || preview.kind === "image"}
                onClick={() => void handleCopy()}
              >
                <Clipboard size={15} /> Copy
              </button>
              <button
                className="button primary"
                disabled={!selectedArtifact}
                onClick={() => void handleExport()}
              >
                <Download size={15} /> Export
              </button>
            </div>
          </div>
          <div className="preview-surface">{renderPreview()}</div>
          {selectedArtifact && (
            <div className="path-bar" title={selectedArtifact.absolutePath}>
              <span className="path-text">{selectedArtifact.absolutePath}</span>
              <button
                className="path-open-link"
                onClick={() => void handleOpenFolder()}
              >
                <FolderOpen size={13} /> Open folder
              </button>
            </div>
          )}
        </section>
          </>
        )}
      </div>
    </main>
  );
}

export default App;
