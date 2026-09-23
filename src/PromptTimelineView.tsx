import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Clipboard,
  FileText,
  MessageSquareText,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  groupTimelinePrompts,
  type TimelineOrganizationMode,
} from "./timelineOrganization";
import type { TimelinePrompt, PromptTimeline } from "./types";

interface PromptTimelineViewProps {
  timeline?: PromptTimeline;
  loading: boolean;
  onRefresh: () => void;
}

function formatTimestamp(timestamp?: number, inferred?: boolean) {
  if (timestamp === undefined) return "Timestamp unavailable";
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
  return inferred ? `${formatted} · file time` : formatted;
}

export function PromptTimelineView({
  timeline,
  loading,
  onRefresh,
}: PromptTimelineViewProps) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [organization, setOrganization] =
    useState<TimelineOrganizationMode>("newest");
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    () => new Set(),
  );
  const [copyStatus, setCopyStatus] = useState<{
    key: string;
    status: "copied" | "failed";
  }>();
  useEffect(() => {
    if (!copyStatus) return;
    const timeout = window.setTimeout(() => setCopyStatus(undefined), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);
  const providers = useMemo(
    () =>
      [...new Set(timeline?.prompts.map((prompt) => prompt.providerName) ?? [])]
        .sort()
        .map((name) => ({ name })),
    [timeline],
  );
  const prompts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (timeline?.prompts ?? []).filter(
      (prompt) =>
        (provider === "all" || prompt.providerName === provider) &&
        (!normalized ||
          `${prompt.text} ${prompt.providerName} ${prompt.sessionId} ${prompt.sourcePath}`
            .toLocaleLowerCase()
            .includes(normalized)),
    );
  }, [provider, query, timeline]);
  const sessionGroups = useMemo(() => groupTimelinePrompts(prompts), [prompts]);

  useEffect(() => {
    const validKeys = new Set(sessionGroups.map((group) => group.key));
    setExpandedSessions((current) => {
      const next = new Set(
        [...current].filter((sessionKey) => validKeys.has(sessionKey)),
      );
      return next.size === current.size ? current : next;
    });
  }, [sessionGroups]);

  async function handleCopyPrompt(key: string, text: string) {
    try {
      await writeText(text);
      setCopyStatus({ key, status: "copied" });
    } catch {
      setCopyStatus({ key, status: "failed" });
    }
  }

  function handleOrganizationChange(mode: TimelineOrganizationMode) {
    setOrganization(mode);
    if (mode === "session") setExpandedSessions(new Set());
  }

  function toggleSession(sessionKey: string) {
    setExpandedSessions((current) => {
      const next = new Set(current);
      if (next.has(sessionKey)) {
        next.delete(sessionKey);
      } else {
        next.add(sessionKey);
      }
      return next;
    });
  }

  function renderPromptCard(
    prompt: TimelinePrompt,
    index: number,
    identity: string,
  ) {
    const promptKey = [
      identity,
      prompt.sourcePath,
      prompt.sessionId,
      prompt.timestampMs ?? index,
      index,
    ].join("-");
    const currentCopyStatus =
      copyStatus?.key === promptKey ? copyStatus.status : undefined;
    return (
      <li key={promptKey}>
        <div className="timeline-card-top">
          <span className={`provider-pill provider-${prompt.providerId}`}>
            {prompt.providerName}
          </span>
          <span className="timeline-time">
            <Clock3 size={12} />
            {formatTimestamp(prompt.timestampMs, prompt.timestampInferred)}
          </span>
        </div>
        <pre>{prompt.text}</pre>
        <div className="timeline-card-bottom">
          <code>{prompt.sessionId}</code>
          <div className="timeline-card-actions">
            <span title={prompt.sourcePath}>
              <FileText size={11} />
              {prompt.sourcePath}
            </span>
            <button
              className={`timeline-copy-button ${currentCopyStatus ?? ""}`}
              onClick={() => void handleCopyPrompt(promptKey, prompt.text)}
              aria-label={`Copy prompt from ${prompt.providerName}`}
              title={
                currentCopyStatus === "failed"
                  ? "Could not copy prompt"
                  : "Copy prompt"
              }
            >
              {currentCopyStatus === "copied" ? (
                <Check size={12} />
              ) : currentCopyStatus === "failed" ? (
                <X size={12} />
              ) : (
                <Clipboard size={12} />
              )}
              {currentCopyStatus === "copied"
                ? "Copied"
                : currentCopyStatus === "failed"
                  ? "Copy failed"
                  : "Copy"}
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <section className="timeline-panel">
      <header className="timeline-header">
        <div>
          <span className="eyebrow">All detected AI tools</span>
          <h1>Prompt Timeline</h1>
          <p>
            {organization === "newest"
              ? "Every recognized local prompt, merged newest-first."
              : "Recognized prompts clustered into local sessions."}
          </p>
        </div>
        <button className="button subtle" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} /> {loading ? "Scanning…" : "Refresh"}
        </button>
      </header>
      <div className="timeline-controls">
        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prompts, tools, sessions, or paths"
            aria-label="Search prompt timeline"
          />
        </label>
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          aria-label="Filter prompt timeline by provider"
        >
          <option value="all">All tools</option>
          {providers.map(({ name }) => (
            <option value={name} key={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={organization}
          onChange={(event) =>
            handleOrganizationChange(
              event.target.value as TimelineOrganizationMode,
            )
          }
          aria-label="Organize prompt timeline"
        >
          <option value="newest">Newest first</option>
          <option value="session">By session</option>
        </select>
      </div>
      <div className="timeline-summary">
        <span>
          {prompts.length} prompt{prompts.length === 1 ? "" : "s"}
        </span>
        {organization === "session" && (
          <span>
            {sessionGroups.length} session
            {sessionGroups.length === 1 ? "" : "s"}
          </span>
        )}
        <span>{timeline?.scannedFiles ?? 0} JSONL files scanned</span>
        {(timeline?.malformedRecords ?? 0) > 0 && (
          <span>{timeline?.malformedRecords} malformed records skipped</span>
        )}
        {timeline?.truncated && <span>Safety limit reached</span>}
      </div>
      <div className="timeline-scroll">
        {loading && !timeline ? (
          <div className="preview-loading">Building prompt timeline…</div>
        ) : prompts.length === 0 ? (
          <div className="empty-state">
            <MessageSquareText size={42} strokeWidth={1.4} />
            <h2>No prompts matched</h2>
            <p>
              Only recognized user prompts in approved local JSONL files appear
              here.
            </p>
          </div>
        ) : organization === "newest" ? (
          <ol className="timeline-list">
            {prompts.map((prompt, index) =>
              renderPromptCard(prompt, index, "newest"),
            )}
          </ol>
        ) : (
          <ol className="timeline-session-list">
            {sessionGroups.map((group) => {
              const expanded = expandedSessions.has(group.key);
              return (
                <li className="timeline-session-group" key={group.key}>
                  <button
                    className="timeline-session-header"
                    onClick={() => toggleSession(group.key)}
                    aria-expanded={expanded}
                  >
                    <span className="timeline-session-chevron">
                      {expanded ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </span>
                    <span
                      className={`provider-pill provider-${group.providerId}`}
                    >
                      {group.providerName}
                    </span>
                    <code title={group.sessionId}>{group.sessionId}</code>
                    <span className="timeline-session-count">
                      {group.prompts.length} prompt
                      {group.prompts.length === 1 ? "" : "s"}
                    </span>
                    <span className="timeline-time">
                      <Clock3 size={12} />
                      {formatTimestamp(group.newestTimestampMs)}
                    </span>
                  </button>
                  {expanded && (
                    <ol className="timeline-list timeline-session-prompts">
                      {group.prompts.map((prompt, index) =>
                        renderPromptCard(prompt, index, group.key),
                      )}
                    </ol>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
