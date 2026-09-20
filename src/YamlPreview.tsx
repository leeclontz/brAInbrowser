import { SyntaxPreview } from "./SyntaxPreview";
import { formatYamlContent } from "./yamlFormat";

interface YamlPreviewProps {
  content: string;
}

export function YamlPreview({ content }: YamlPreviewProps) {
  const formatted = formatYamlContent(content);
  const summary =
    formatted.documentCount > 1
      ? `${formatted.documentCount} YAML documents`
      : undefined;

  return (
    <SyntaxPreview
      code={formatted.text}
      language="yaml"
      warning={formatted.warning}
      summary={summary}
    />
  );
}
