import { formatJsonContent, type JsonFormat } from "./jsonFormat";
import { SyntaxPreview } from "./SyntaxPreview";

interface JsonPreviewProps {
  content: string;
  format: JsonFormat;
}

export function JsonPreview({ content, format }: JsonPreviewProps) {
  const formatted = formatJsonContent(content, format);
  const summary =
    format === "jsonl"
      ? `${formatted.recordCount} JSONL record${
          formatted.recordCount === 1 ? "" : "s"
        }`
      : undefined;

  return (
    <SyntaxPreview
      code={formatted.text}
      language="json"
      warning={formatted.warning}
      summary={summary}
    />
  );
}
