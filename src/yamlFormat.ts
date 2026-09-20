import { parseAllDocuments } from "yaml";

export interface FormattedYaml {
  text: string;
  warning?: string;
  documentCount: number;
}

export function formatYamlContent(source: string): FormattedYaml {
  if (!source.trim()) {
    return { text: source, documentCount: 0 };
  }

  try {
    const documents = parseAllDocuments(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    const error = documents.flatMap((document) => document.errors)[0];
    if (error) {
      return {
        text: source,
        warning: `Unable to format YAML: ${error.message}`,
        documentCount: 0,
      };
    }
    return {
      text: documents
        .map((document, index) => {
          const text = document
            .toString({ indent: 2, lineWidth: 0 })
            .trimEnd();
          return index === 0 ? text : text.replace(/^---\s*\n/, "");
        })
        .join("\n---\n"),
      documentCount: documents.length,
    };
  } catch (error) {
    return {
      text: source,
      warning: `Unable to format YAML: ${
        error instanceof Error ? error.message : "Unknown parse error"
      }`,
      documentCount: 0,
    };
  }
}
