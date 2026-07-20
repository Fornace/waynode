/** Composer & transcript behavior contracts (failing-first).
 *
 * Two layers:
 * (A) Behavior tests via importTs for the sessionDrafts module
 *     (set/get/clear per session, isolation, clear-on-send semantics).
 * (B) Source-contract assertions in the style of test-public-trust.mjs,
 *     readFileSync'ing the component / CSS / HTML sources to verify each
 *     confirmed bug fix is actually present in the code.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// ──────────────────────────────────────────────────────────────────────────
// Layer A — behavior: sessionDrafts module (importTs, runs the real TS).
// ──────────────────────────────────────────────────────────────────────────
const tsPath = join(process.cwd(), "frontend/node_modules/typescript/lib/typescript.js");
const ts = await import(pathToFileURL(tsPath));
async function importTs(path) {
  const source = readFileSync(path, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const drafts = await importTs(join(process.cwd(), "frontend/src/lib/sessionDrafts.ts"));

// Start from a clean slate so the run is deterministic regardless of any
// sessionStorage state left by a previous test process.
for (const id of ["b-s1", "b-s2", "b-s3"]) drafts.clear(id);

// set/get round-trip
drafts.set("b-s1", "hello world");
assert.equal(drafts.get("b-s1"), "hello world", "set→get round-trip preserves text");

// Isolation between sessions: writing session 2 does not leak into session 1.
assert.equal(drafts.get("b-s2"), "", "unset session returns empty string, not null/undefined");
drafts.set("b-s2", "second session draft");
assert.equal(drafts.get("b-s1"), "hello world", "session 1 untouched by session 2 write");
assert.equal(drafts.get("b-s2"), "second session draft");

// clear() is scoped per session — clearing one never touches another.
drafts.clear("b-s1");
assert.equal(drafts.get("b-s1"), "", "cleared session reads empty");
assert.equal(drafts.get("b-s2"), "second session draft", "sibling session survives clear");

// clear-on-send semantics: clear is idempotent and yields empty storage,
// which is the contract the send path relies on ("draft gone after send").
drafts.clear("b-s2");
assert.equal(drafts.get("b-s2"), "", "send-emulating clear leaves empty");
drafts.clear("b-s2");
assert.equal(drafts.get("b-s2"), "", "clear is idempotent");

// A fresh write after a clear works (e.g. user starts a new draft post-send).
drafts.set("b-s3", "post-send draft");
assert.equal(drafts.get("b-s3"), "post-send draft");
drafts.clear("b-s3");

// ──────────────────────────────────────────────────────────────────────────
// Layer B — source-contract assertions (the failing-first layer).
// Each assertion below corresponds to one confirmed bug and MUST already be
// present in the source for the gate to pass.
// ──────────────────────────────────────────────────────────────────────────
const chatTab = read("frontend/src/components/ChatTab.tsx");
const chatMessage = read("frontend/src/components/ChatMessage.tsx");
const markdown = read("frontend/src/components/MarkdownDocument.tsx");
const css = read("frontend/src/styles/chat-composer.css");
const html = read("frontend/index.html");

// Helper: extract the substring of a named function/const body so we can make
// ordering assertions inside it (used by the synchronous-clear contract).
function bodyAfter(source, marker) {
  const idx = source.indexOf(marker);
  assert.ok(idx >= 0, `marker not found in source: ${marker}`);
  return source.slice(idx);
}

// ── Bug 1: synchronous draft clear + in-flight submit guard ──
// The trimmed prompt must be captured and the input cleared BEFORE any await
// on store.send/store.queue, and an in-flight guard must prevent re-entry.
assert.match(chatTab, /submitInFlight/, "Bug 1: in-flight submit guard ref exists");
{
  const send = bodyAfter(chatTab, "const sendMessage");
  const setInputIdx = send.indexOf('setInput("")');
  const awaitIdx = send.indexOf("await store.send");
  assert.ok(setInputIdx > 0, "Bug 1: sendMessage clears the input");
  assert.ok(awaitIdx > 0, "Bug 1: sendMessage awaits store.send");
  assert.ok(setInputIdx < awaitIdx, "Bug 1: sendMessage clears input BEFORE awaiting store.send (no key-repeat double-submit)");
}
{
  const q = bodyAfter(chatTab, "const handleQueue");
  const setInputIdx = q.indexOf('setInput("")');
  const awaitIdx = q.indexOf("await store.queue");
  assert.ok(setInputIdx > 0, "Bug 1: handleQueue clears the input");
  assert.ok(awaitIdx > 0, "Bug 1: handleQueue awaits store.queue");
  assert.ok(setInputIdx < awaitIdx, "Bug 1: handleQueue clears input BEFORE awaiting store.queue");
}

// ── Bug 2: IME composition guard (CJK Enter) ──
assert.match(chatTab, /isComposing/, "Bug 2: keydown checks nativeEvent.isComposing");
assert.match(chatTab, /keyCode === 229/, "Bug 2: keydown guards the legacy 229 keyCode");

// ── Bug 3: one-shot failedDraft restore (no refill-on-empty loop) ──
// The previous broken effect had deps `[state.failedDraft, input]` which
// re-filled the composer every time the user emptied it. The fix removes
// `input` from the dep array and guards with a one-shot id ref.
assert.doesNotMatch(chatTab, /\[state\.failedDraft, input\]/, "Bug 3: failedDraft effect no longer re-fires on every input change");
assert.match(chatTab, /restoredDraft/, "Bug 3: one-shot restore guard (per-failedDraft id) is present");

// ── Bug 4: unsent drafts survive session switch via sessionDrafts ──
assert.match(chatTab, /from ["']\.\.\/lib\/sessionDrafts["']/, "Bug 4: ChatTab imports the sessionDrafts module");
assert.match(chatTab, /drafts\.get\(/, "Bug 4: ChatTab seeds input from sessionDrafts.get");
assert.match(chatTab, /drafts\.set\(/, "Bug 4: ChatTab writes the live draft via sessionDrafts.set");
assert.match(chatTab, /drafts\.clear\(/, "Bug 4: ChatTab clears the stored draft on send (clear-on-send)");

// ── Bug 5: iOS focus-zoom — composer input 16px on mobile ──
assert.match(css, /\.composer-input[^}]*font-size:\s*16px/, "Bug 5: .composer-input has a 16px font-size override (mobile, prevents Safari auto-zoom)");

// ── Bug 6: soft-keyboard covers composer — viewport interactive-widget ──
assert.match(html, /interactive-widget=resizes-content/, "Bug 6: viewport meta includes interactive-widget=resizes-content");

// ── Bug 7: newline-btn 44px min-width on touch ──
assert.match(css, /\.newline-btn[^}]*min-width:\s*44px/, "Bug 7: .newline-btn has min-width: 44px (touch-target compliant)");

// ── Bug 8: composer_mode resyncs from prop while mounted ──
assert.match(chatTab, /\[session\.composer_mode\]/, "Bug 8: a useEffect re-syncs local mode when session.composer_mode changes");

// ── Bug 9: UserContent preserves text after the [Uploaded file…] marker ──
assert.match(chatMessage, /slice\(end\s*\+\s*1\)/, "Bug 9: UserContent renders the suffix past the closing ] of the upload marker");

// ── Bug 10: MessageRow is memoized (long-transcript perf) ──
assert.match(chatMessage, /export const MessageRow = memo\(/, "Bug 10: MessageRow is wrapped in React.memo so untouched rows skip re-render on streamed tokens");

// ── Bug 11: clipboard guard (plain-HTTP self-host: navigator.clipboard may be undefined) ──
assert.match(chatMessage, /navigator\.clipboard\?\./, "Bug 11: ChatMessage guards navigator.clipboard access (no throw on plain HTTP)");
assert.match(markdown, /navigator\.clipboard\?\./, "Bug 11: MarkdownDocument guards navigator.clipboard access (no throw on plain HTTP)");

// ── Bug 12: Escape-to-blur (KEYBOARD-CONTRACT §1.3) ──
assert.match(chatTab, /["']Escape["']/, "Bug 12: composer keydown handles Escape");
assert.match(chatTab, /\.blur\(\)/, "Bug 12: Escape branch blurs the composer input");

// ── Bug 13: incoming messages announced (a11y) ──
assert.match(chatTab, /role="log"/, "Bug 13: chat-messages container exposes role=log");
assert.match(chatTab, /aria-live="polite"/, "Bug 13: chat-messages container is aria-live polite");

// ── File-length maintainability gate (matches check-file-lengths.mjs at 400) ──
for (const path of [
  "frontend/src/components/ChatTab.tsx",
  "frontend/src/components/ChatComposer.tsx",
  "frontend/src/components/ChatMessage.tsx",
  "frontend/src/components/MarkdownDocument.tsx",
  "frontend/src/lib/sessionDrafts.ts",
  "frontend/src/styles/chat-composer.css",
  "frontend/index.html",
  "e2e/test-composer-behaviors.mjs",
]) {
  const lines = read(path).split("\n").length;
  assert.ok(lines <= 400, `${path} has ${lines} lines (limit 400)`);
}

console.log("composer behaviors: sessionDrafts module + 13 source contracts PASS");
