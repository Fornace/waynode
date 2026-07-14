import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownDocumentProps {
  children: string;
}

export function MarkdownDocument({ children }: MarkdownDocumentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: MarkdownLink,
        code: MarkdownCode,
        pre: ({ children: code }) => <>{code}</>,
        table: ({ children: rows }) => <div className="markdown-table-scroll" tabIndex={0}><table>{rows}</table></div>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function MarkdownLink({ href = "", children }: { href?: string; children?: ReactNode }) {
  let destination = href;
  try {
    const url = new URL(href, window.location.origin);
    destination = url.protocol === "mailto:" ? url.pathname : url.origin === window.location.origin ? url.pathname : url.host;
  } catch {
    // Keep the literal destination for non-URL schemes and incomplete links.
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" title={`Open ${href}`}>
      <span>{children}</span>
      <small className="markdown-link-destination">{destination}</small>
    </a>
  );
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const rawText = String(children ?? "");
  const text = rawText.replace(/\n$/, "");
  const languageClass = className?.split(" ").find((name) => name.startsWith("language-"));
  const language = languageClass?.slice("language-".length) || "text";
  const block = Boolean(languageClass) || rawText.endsWith("\n") || text.includes("\n");
  if (!block) return <code className={className}>{children}</code>;
  return <CodeBlock code={text} language={language} />;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [wrapped, setWrapped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lineCount = code.split("\n").length;
  const collapsible = lineCount > 24;

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <figure className={`markdown-code ${wrapped ? "is-wrapped" : ""} ${expanded ? "is-expanded" : ""}`}>
      <figcaption>
        <span>{language}</span>
        <span className="markdown-code-meta">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
        <button type="button" onClick={() => setWrapped((value) => !value)} aria-pressed={wrapped}>{wrapped ? "No wrap" : "Wrap"}</button>
        <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </figcaption>
      <div className="markdown-code-scroll" tabIndex={0}>
        <pre><code>{code}</code></pre>
      </div>
      {collapsible && (
        <button className="markdown-code-expand" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : `Show all ${lineCount} lines`}
        </button>
      )}
    </figure>
  );
}
