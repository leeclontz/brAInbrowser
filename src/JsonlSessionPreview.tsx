import { useMemo, useState } from "react";
import { Clock3, MessageSquareText } from "lucide-react";
import { JsonPreview } from "./JsonPreview";
import { extractPromptHistory } from "./promptHistory";

interface JsonlSessionPreviewProps {
  content: string;
}

function formatPromptTimestamp(timestamp?: number) {
  if (timestamp === undefined) return "Timestamp unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

export function JsonlSessionPreview({ content }: JsonlSessionPreviewProps) {
  const [view, setView] = useState<"history" | "raw">("history");
  const history = useMemo(() => extractPromptHistory(content), [content]);

  return (
    <div className="session-preview">
      <div className="session-view-tabs">
        <button
          className={view === "history" ? "selected" : ""}
          onClick={() => setView("history")}
        >
          <MessageSquareText size={14} /> Prompt History
        </button>
        <button
          className={view === "raw" ? "selected" : ""}
          onClick={() => setView("raw")}
        >
          {"{ }"} Raw JSONL
        </button>
      </div>

      {view === "raw" ? (
        <JsonPreview content={content} format="jsonl" />
      ) : (
        <div className="prompt-history">
          <div className="prompt-history-summary">
            <span>
              {history.prompts.length} prompt
              {history.prompts.length === 1 ? "" : "s"} · newest first
            </span>
            {history.parseErrors > 0 && (
              <span>{history.parseErrors} malformed record(s) skipped</span>
            )}
          </div>
          {history.prompts.length === 0 ? (
            <div className="empty-state prompt-history-empty">
              <MessageSquareText size={38} strokeWidth={1.4} />
              <h2>No user prompts recognized</h2>
              <p>
                This JSONL format may use a provider-specific schema. The complete
                file remains available in Raw JSONL.
              </p>
            </div>
          ) : (
            <ol>
              {history.prompts.map((prompt) => (
                <li key={`${prompt.sourceLine}-${prompt.timestamp ?? "none"}`}>
                  <div className="prompt-card-header">
                    <span>
                      <Clock3 size={12} />
                      {formatPromptTimestamp(prompt.timestamp)}
                    </span>
                    {prompt.sessionId && <code>{prompt.sessionId}</code>}
                  </div>
                  <pre>{prompt.text}</pre>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
