import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_LINES = 400;

// These files are rewritten by their owning tools. Hand-editing or splitting
// them would make npm/Xcode regeneration nondeterministic.
const GENERATED_TEXT_FILES = new Set([
  "package-lock.json",
  "frontend/package-lock.json",
  "native-app/Waynode.xcodeproj/project.pbxproj",
]);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const violations = [];

for (const file of files) {
  if (GENERATED_TEXT_FILES.has(file)) continue;
  if (!existsSync(file)) continue;

  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;

  const content = bytes.toString("utf8");
  const lineCount = content.length === 0
    ? 0
    : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

  if (lineCount > MAX_LINES) violations.push({ file, lineCount });
}

if (violations.length > 0) {
  console.error(`Files above the ${MAX_LINES}-line maintainability limit:`);
  for (const { file, lineCount } of violations.sort((a, b) => b.lineCount - a.lineCount)) {
    console.error(`  ${String(lineCount).padStart(5)}  ${file}`);
  }
  process.exit(1);
}

console.log(`File-length check passed: all human-maintained files are <= ${MAX_LINES} lines.`);
