import { AlertTriangle } from "lucide-react";
import { parseCsv } from "./csvFormat";

const MAX_DISPLAY_ROWS = 500;
const MAX_DISPLAY_COLUMNS = 100;

interface CsvPreviewProps {
  content: string;
}

export function CsvPreview({ content }: CsvPreviewProps) {
  const parsed = parseCsv(content);
  if (parsed.rows.length === 0) {
    return <div className="preview-loading">This CSV file is empty.</div>;
  }

  const headers = parsed.rows[0].slice(0, MAX_DISPLAY_COLUMNS);
  const body = parsed.rows.slice(1, MAX_DISPLAY_ROWS + 1);
  const columnCount = Math.max(
    headers.length,
    ...body.map((row) => Math.min(row.length, MAX_DISPLAY_COLUMNS)),
  );
  const displayHeaders = Array.from(
    { length: columnCount },
    (_, index) => headers[index] || `Column ${index + 1}`,
  );
  const limited = parsed.rows.length - 1 > MAX_DISPLAY_ROWS ||
    parsed.rows.some((row) => row.length > MAX_DISPLAY_COLUMNS);

  return (
    <div className="csv-preview">
      {(parsed.warning || limited) && (
        <div className="syntax-warning">
          <AlertTriangle size={16} />
          <span>
            {[parsed.warning, limited
              ? `Preview limited to ${MAX_DISPLAY_ROWS} rows and ${MAX_DISPLAY_COLUMNS} columns.`
              : undefined]
              .filter(Boolean)
              .join(" ")}
          </span>
        </div>
      )}
      <div className="csv-summary">
        {parsed.rows.length - 1} data rows · {columnCount} columns
      </div>
      <div className="csv-table-wrap">
        <table className="csv-table">
          <thead>
            <tr>
              <th className="csv-row-number">#</th>
              {displayHeaders.map((header, index) => (
                <th key={index}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="csv-row-number">{rowIndex + 1}</th>
                {displayHeaders.map((_, columnIndex) => (
                  <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
