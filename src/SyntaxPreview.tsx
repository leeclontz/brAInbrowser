import { Highlight, type Language, type PrismTheme } from "prism-react-renderer";
import { AlertTriangle } from "lucide-react";

const brainSyntaxTheme: PrismTheme = {
  plain: {
    color: "#d5d1dc",
    backgroundColor: "transparent",
  },
  styles: [
    {
      types: ["property", "attr-name", "key"],
      style: { color: "#8fd7ff" },
    },
    {
      types: ["string", "char", "scalar"],
      style: { color: "#b8e994" },
    },
    {
      types: ["number", "datetime"],
      style: { color: "#d9a7ff" },
    },
    {
      types: ["boolean", "constant", "important"],
      style: { color: "#ffb86b" },
    },
    {
      types: ["null", "keyword", "tag"],
      style: { color: "#ff7f9f", fontStyle: "italic" },
    },
    {
      types: ["comment"],
      style: { color: "#6e7785", fontStyle: "italic" },
    },
    {
      types: ["anchor", "alias", "directive"],
      style: { color: "#c6a7ff" },
    },
    {
      types: ["punctuation", "operator"],
      style: { color: "#817b8b" },
    },
  ],
};

interface SyntaxPreviewProps {
  code: string;
  language: Language;
  warning?: string;
  summary?: string;
}

export function SyntaxPreview({
  code,
  language,
  warning,
  summary,
}: SyntaxPreviewProps) {
  return (
    <div className="syntax-preview">
      {warning && (
        <div className="syntax-warning" role="alert">
          <AlertTriangle size={15} />
          <span>{warning} Showing the original content.</span>
        </div>
      )}
      {!warning && summary && <div className="syntax-summary">{summary}</div>}
      <Highlight
        theme={brainSyntaxTheme}
        code={code}
        language={warning ? "plain" : language}
      >
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={`${className} syntax-code`} style={style}>
            {tokens.map((line, lineIndex) => (
              <div
                {...getLineProps({ line })}
                className="syntax-line"
                key={lineIndex}
              >
                <span className="syntax-line-number" aria-hidden="true">
                  {lineIndex + 1}
                </span>
                <span className="syntax-line-content">
                  {line.map((token, tokenIndex) => (
                    <span
                      {...getTokenProps({ token })}
                      key={`${lineIndex}-${tokenIndex}`}
                    />
                  ))}
                </span>
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
