export type JsonFormat = "json" | "jsonl";

export interface FormattedJson {
  text: string;
  warning?: string;
  recordCount: number;
}

function parseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown parse error";
}

export function formatJsonContent(
  source: string,
  format: JsonFormat,
): FormattedJson {
  if (format === "json") {
    try {
      return {
        text: JSON.stringify(JSON.parse(source), null, 2),
        recordCount: 1,
      };
    } catch (error) {
      return {
        text: source,
        warning: `Unable to format JSON: ${parseErrorMessage(error)}`,
        recordCount: 0,
      };
    }
  }

  const records = source
    .split(/\r?\n/)
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter((record) => record.text.trim().length > 0);

  try {
    return {
      text: records
        .map((record) => JSON.stringify(JSON.parse(record.text), null, 2))
        .join("\n\n"),
      recordCount: records.length,
    };
  } catch (error) {
    const invalidRecord = records.find((record) => {
      try {
        JSON.parse(record.text);
        return false;
      } catch {
        return true;
      }
    });
    return {
      text: source,
      warning: `Unable to format JSONL record ${
        invalidRecord?.lineNumber ?? "unknown"
      }: ${parseErrorMessage(error)}`,
      recordCount: 0,
    };
  }
}
