import type { GitFile } from "../types";

const FILE_STATUS: Record<GitFile["status"], { code: string; label: string }> = {
  modified: { code: "M", label: "Modified" },
  added: { code: "A", label: "Added" },
  deleted: { code: "D", label: "Deleted" },
  renamed: { code: "R", label: "Renamed" },
  copied: { code: "C", label: "Copied" },
  conflict: { code: "U", label: "Conflict" },
  untracked: { code: "?", label: "Untracked" },
};

export function GitStatusBadge({ status }: { status: GitFile["status"] }) {
  const evidence = FILE_STATUS[status];
  return (
    <span className={`git-status-badge is-${status}`} title={evidence.label}>
      <span aria-hidden="true">{evidence.code}</span>
      <span className="review-sr-only">{evidence.label}</span>
    </span>
  );
}

type DiffKind = "context" | "add" | "del" | "hunk" | "meta";

interface DiffRow {
  kind: DiffKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export function DiffView({ text }: { text: string }) {
  const rows = parseUnifiedDiff(text);
  return (
    <div className="git-diff-view" role="table" aria-label="Unified diff with old and new line numbers">
      {rows.map((row, index) => (
        <div key={index} className={`diff-line diff-${row.kind}`} role="row" aria-label={rowLabel(row)}>
          <span className="diff-change" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</span>
          <span className="diff-line-number is-old" role="cell" aria-label={row.oldLine === null ? "No old line" : `Old line ${row.oldLine}`}>{row.oldLine ?? ""}</span>
          <span className="diff-line-number is-new" role="cell" aria-label={row.newLine === null ? "No new line" : `New line ${row.newLine}`}>{row.newLine ?? ""}</span>
          <span className="diff-text" role="cell">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function parseUnifiedDiff(text: string): DiffRow[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return text.split("\n").map((source) => {
    if (source.startsWith("@@")) {
      const hunk = source.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = hunk ? Number(hunk[1]) : null;
      newLine = hunk ? Number(hunk[2]) : null;
      return { kind: "hunk", text: source, oldLine: null, newLine: null };
    }
    if (source.startsWith("+++") || source.startsWith("---") || source.startsWith("diff ") || source.startsWith("index ")) {
      return { kind: "meta", text: source, oldLine: null, newLine: null };
    }
    if (source.startsWith("+") && oldLine !== null && newLine !== null) {
      const row = { kind: "add" as const, text: source.slice(1), oldLine: null, newLine };
      newLine += 1;
      return row;
    }
    if (source.startsWith("-") && oldLine !== null && newLine !== null) {
      const row = { kind: "del" as const, text: source.slice(1), oldLine, newLine: null };
      oldLine += 1;
      return row;
    }
    const row = { kind: "context" as const, text: source.startsWith(" ") ? source.slice(1) : source, oldLine, newLine };
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
    return row;
  });
}

function rowLabel(row: DiffRow) {
  if (row.kind === "add") return `Added at new line ${row.newLine}`;
  if (row.kind === "del") return `Deleted from old line ${row.oldLine}`;
  if (row.kind === "context" && row.oldLine !== null) return `Context at old line ${row.oldLine}, new line ${row.newLine}`;
  if (row.kind === "hunk") return `Diff hunk ${row.text}`;
  return row.text;
}
