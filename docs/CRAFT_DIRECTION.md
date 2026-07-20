# Waynode Craft Direction

## Direction and authority

Waynode is **the durable worktree for agent work**. The product is not a chatbot, a remote task queue, or an IDE in a browser. Its canonical loop is: **connect a repository → direct or delegate → leave safely → return to a truthful status → review the diff → commit and push**. Every screen must answer, without opening a menu: **which worktree, which branch, what the agent is doing, what changed, and what is safe to do next**.

This document is the implementation and review authority for public web, authenticated web, iPhone, iPad, and Mac. When current UI, mockups, or older native notes conflict with it, this direction wins. Product language uses **Worktree** for the cloned repository and **Session** for its persistent conversation/run. “Space,” “Waynode AI,” and generic “workspace” copy are removed from user-facing UI.

Preserve the product’s real strengths: server-resident sessions, cross-device rehydration, rich streamed blocks, goal mode, a real PTY, Git review, GitHub/GitLab, hosted/self-hosted choice, the graph mark, and the current native SwiftTerm and regular-width split view work. Preserve drafts, selection, scroll position, and in-flight work across navigation and relaunch.

Remove emoji decoration, aurora/glow fields, glass on content, faux browser/phone/terminal mockups, inert controls, decorative metrics, redundant bordered cards, permanent model prominence, and undifferentiated black emptiness. Never use celebration where the product owes certainty. Do not add an editor, dashboard, activity feed, or more navigation.

## The visual and interaction system

The system is **Quiet Graphite**: a matte work surface with one blue continuity signal.

- Web uses system sans and system mono. Work text is 14–15px/1.55; labels 12–13px; prose measures 68–76 characters. Marketing headings may be large; authenticated headings may not.
- Authenticated web defaults to graphite (`#0B0B0C` content, `#121214` navigation, `#18181B` raised controls), with white at 92/64/38% hierarchy and Waynode blue `#3B82F6` only for selection, focus, links, and the primary action. Green, amber, and red mean success, attention, and failure only.
- Borders are 8–12% white, one pixel. Radius is 8px for controls, 12px for panels, and a capsule only for status. Shadows belong only to menus and sheets. No gradients except a barely perceptible public-web image fade.
- Native uses semantic colors, Dynamic Type, SF Symbols, system spacing, standard bars/sheets/menus, and system materials on the **functional layer only**. Conversation, code, diffs, and terminal stay matte. Honor light/dark appearance, Increased Contrast, Reduce Transparency, and Reduce Motion; never force dark mode.
- The Waynode mark identifies the product and the first assistant turn. It does not spin. Animation is functional: 160–220ms state transitions, a restrained indeterminate progress treatment, and no movement under Reduce Motion.
- Every icon has a label in menus/tooltips and an accessibility name. Web targets are at least 40px desktop and 44px touch. Focus is a visible blue outer ring, never color alone.

## Information hierarchy and progressive disclosure

The hierarchy is **Worktree / Session / Review**.

Always visible: repository, branch, session title, connection/run state, changed-file count, and primary next action. Visible when relevant: lock owner, ahead/behind, goal progress, pending input, quota, and errors. One click away: model, terminal, commit details, branches, session actions, and settings. Inside disclosure or context menus: reasoning, raw tool arguments/output, credentials, IDs, archived sessions, destructive actions, and diagnostics.

Controls appear at the point of consequence. Commit lives after file review; retry lives inside the failed surface; stop replaces send while a turn is active. Disabled actions explain why. Destructive confirmation names the affected worktree/session and whether files or messages survive. Never put recovery only in a toast.

## Attention budget, variable text, and escape paths

Every surface has an attention budget. A person returning to Waynode should first see what changed, whether work is safe, and the single useful next action—not a wall of equal-weight controls. Frequent actions remain direct; secondary actions move into one predictable menu; diagnostics and destructive controls stay behind labeled disclosure. Persistent banners are reserved for conditions that still require action. Completed status collapses quietly, and repeated connection noise never accumulates into a transcript of anxiety.

Design and test with adversarial real text: long repository and branch names, long session titles, localized button labels, multi-line provider errors, URLs, tokens, filenames, commit subjects, organization names, and generated prose. Identity text may truncate only when the full value is available through selection, help, disclosure, or a detail surface. Instructions and failures wrap rather than shrink. Primary actions keep stable placement, and no message can push Close, Cancel, Back, Done, Retry, or the composer off-screen.

Every temporary surface has an obvious escape. Sheets and dialogs show a platform-standard Close, Cancel, or Done action in a consistent location; popovers close on outside click and Escape; destructive confirmations include a safe cancel; full-screen routes provide Back; long tasks distinguish hiding the surface from cancelling the work. Never require window chrome, a swipe gesture, or knowledge of a keyboard shortcut as the only way out. Dismissal preserves drafts and in-flight work unless the confirmation explicitly says otherwise.

## Public web

The public site is one continuous narrative — the life of a single real job through the product — told in **explanatory frames**, not screenshots. Mockups must explain, not imitate: meaning over fidelity; recognizable as the real product, simplified until the idea reads instantly; every frame teaches what Waynode does. Frames are pure CSS/SVG: no raster images anywhere on the page, no external hotlinks, no faux browser/phone chrome with fake traffic lights — device frames are bare geometric outlines. Every interactive-looking element inside a frame is inert (aria-hidden, no focusable mock controls).

Five beats, in this order:

1. Hero + composer frame: **"Leave the laptop. Not the worktree."** One sentence on the durable repository, server-resident agent, and Git evidence; primary "Start 15-day hosted trial," secondary "Self-host Waynode." Below it, the composer with the send-mode tri-selector `message | goal | hammersmith` (hammersmith selected): the message is a job description for a verified swarm.
2. Verified-run frame: a Hammersmith run as quiet sidebar rows with plain-text check counts, one flat rounded-rect active row, and a thin progress hairline. Delegated work returns verified by executed checks, not by a reassuring message.
3. Evidence frame: the session beside its review inspector — three changed files and one simplified diff in system mono. "Done" is a diff you can inspect before you commit. The worktree is the product.
4. Handoff frame: the same session drawn twice — wide desktop outline and narrow phone outline, identical quiet rows — naming the native iOS/macOS client. Close the laptop, open the phone, nothing to reconstruct.
5. Deployment: Cloud (15-day trial; Starter $39 / Pro $99 / Team $249 per month; Hammersmith verified-swarm tier $8.99/mo) and self-hosted (free, MIT, your keys) as equal, factual choices, plus the install command and a link to the pricing doc. Footer with GitHub, guides, agent-readable content, and sign-in. Public plan
   cards stay removed; hosted billing remains inside organization settings.

On viewports above 1024px a persistent left rail (~200px, fixed) echoes the app's sidebar: quiet rows labeling the five beats, the active row carrying the flat blue rounded-rect as the visitor scrolls. At or below 1024px the rail collapses away. The rail is part of the page's structure, not decoration.

Remove the marquee, generic competitor comparison, miniature illegible terminal, repeated CTA sections, "Most popular," and any App Store billing or hosted-terminal claim not enabled in production. Motion is functional and slow (a blinking caret, checks flipping running → passed); everything is reachable and meaningful with Reduce Motion on.

Login is a separate, calm surface—not embedded at the end of marketing. Show mark, "Sign in to Waynode," GitHub/GitLab providers actually enabled, a short statement that work stays on the configured server, and a subdued server chooser for self-hosting. Dev-token login is development-only and absent from production UI.

## Authenticated web

Desktop is a three-part workbench: 240–280px Worktree/Session sidebar, fluid conversation, and a 360–480px Review inspector. The inspector docks without covering content and remembers width. The title bar reads `repository / branch` then session title; at its trailing edge sit one run-state label and changed-file button. Model and settings move into the session menu. Chat, Terminal, and Review are not three equal tabs: conversation is default, Review is an inspector, and Terminal is a mode available only when capability says it works.

The sidebar has one primary action, “New worktree.” Repository rows disclose sessions; active work, changed count, and lock state outrank session totals. Archived sessions are hidden behind “Archived.” Empty organization, worktree, and session states each offer the exact next action; remove the rocket/chat/sparkle art.

At ≤768px, use a modal navigation drawer, a compact two-line identity bar, a full-screen Review route, and a bottom composer. Show only menu, title/state, and changed-file affordance in the top bar. Never squeeze model, settings, review, chat, and terminal into one row. At all widths, conversation and composer share one centered reading column while code/diffs can expand wider.

## Generated and received content

Generated text is a first-class work artifact, not decorative chat. Assistant output is an unboxed editorial column; a small Waynode mark appears once at the turn start. User instructions remain compact, right-aligned, and blue-tinted; goals use a quiet target label, not emoji. System events do not masquerade as messages: connection, queue, lock, clone, and error events render as compact timeline/status rows tied to their surface.

Render CommonMark/GFM through maintained parsers, not a hand-built variable-text parser. Streaming must tolerate incomplete Markdown without reflowing earlier content. Support headings, paragraphs, nested lists, task lists, links, blockquotes, tables, thematic breaks, inline/fenced code, and attached files. Tables scroll horizontally; code has language, Copy, and Wrap; long blocks collapse after 24 lines with “Show all.” Preserve whitespace and expose “View raw Markdown.” Links show their destination before opening.

Tool activity is a chronological run trace. While active, show a human label such as “Running tests” or “Reading `AuthView.swift`,” duration, and live status. Completed tools collapse to one line; failed tools stay open with recovery. Raw tool name, arguments, and output are secondary disclosure. Human labels come from structured metadata or a fast semantic model—not brittle text matching. Reasoning is collapsed by default, labeled “Reasoning,” selectable, and visually subordinate to the answer.

Every completed answer offers a context menu: Copy, Copy as Markdown, Select Text, Quote in Reply, and Share/Save on native platforms. Code, links, tables, and tool output have local actions. Text selection must remain stable during streaming. A “Jump to latest” control appears when the reader scrolls away; new tokens never pull them back. At first-token latency show “Starting agent…” followed by the latest meaningful server phase—never silent emptiness or dots alone.

## Platform-specific authority

### iPhone

Use one `NavigationStack`: Worktrees → Sessions → Session. Account is a toolbar destination, not a permanent tab. The session opens on status and latest conversation; branch/change state sits below the title. Review opens full-screen and returns to the same scroll/draft. Terminal appears in the session menu only when supported. The composer is thumb-reachable, grows to six lines, keeps the draft through termination, and uses standard Photos/Files pickers. Goal completion, input-needed, budget, and failure notifications deep-link to the exact session and relevant block. Context menus and the Share sheet own secondary text actions.

### iPad

Use `NavigationSplitView`: Worktrees / Sessions / Session, with Review as the system inspector. In portrait it collapses in that order without losing selection; in landscape and Stage Manager all columns resize. Chat and terminal may share a segmented detail mode when terminal is supported. Hardware keyboard, pointer hover, drag-and-drop attachments, and inspector resizing are required. No stretched iPhone bottom-tab shell.

### Mac

Ship a first-class macOS SwiftUI/AppKit target sharing WaynodeCore—not a Catalyst release. Use a resizable three-pane window, native unified toolbar, inspector, menus, contextual actions, Settings scene, notifications, and window restoration. Support multiple session windows and tabs. Required commands: new window `⌘N`, new worktree `⌥⌘N`, new session `⇧⌘N`, send `⌘↩`, search transcript `⌘F`, toggle Review `⌥⌘R`, toggle Terminal `⌥⌘T`, and command palette `⇧⌘P`. Terminal receives raw keys while focused; reserved app shortcuts remain reachable through menus. Drag repository URLs/files into appropriate destinations.

## State model

Every state is explicit, semantic, and paired with recovery:

| Surface | Required states and treatment |
|---|---|
| Account | checking session; signed out; provider unavailable; OAuth cancelled/failed; server unreachable; token expired; invite invalid/expired; forbidden. Keep entered server, explain outcome, offer Retry or Sign in. |
| Worktree | empty; provider connection needed; clone queued/cloning with phase; ready; clone failed/cancelled; missing/deleted; quota exceeded; locked by another session. Preserve progress/history and name the next safe action. |
| Session/run | loading history; ready; sending/acknowledged; queued; starting; streaming; tool running; needs input; paused; stop requested/stopped; budget limited; complete; agent crashed; reconnecting/resumed. Draft and transcript persist; one state cannot appear as another. |
| Git review | checking; clean; changed; agent editing/partial; ahead; behind; diverged; conflict; detached; commit/pull/push running, succeeded, rejected, unauthorized, or no upstream. State the affected branch/files and recovery before enabling mutation. |
| Terminal | unsupported (hide entry); connecting; connected; locked while agent writes; disconnected; exited; failed; reconnecting. Preserve visible scrollback and provide Retry/Restart; never leave a blank terminal with only “[disconnected].” |
| Global | empty organization; loading; offline with cached content; stale cache; not found; permission loss; maintenance/update required. Keep usable cached content, timestamp it, and place recovery in context. |

Success feedback is quiet and persistent where future decisions depend on it. Errors use plain copy: what happened, what remains safe, and what to do. Never expose raw HTTP or WebSocket language as primary copy.

## Priority and dependency order

1. **P0—Truth contract:** shared capability, connection, run, lock, clone, and Git state vocabulary plus resumable events. Everything visual depends on truthful state.
2. **P0—Generated content and session core:** editorial renderer, trace disclosure, draft/scroll persistence, streaming phases, offline/reconnect, and text actions. This is the most-seen surface.
3. **P0—Authenticated web workbench:** identity bar, hierarchy, docked Review, responsive compact shell, and domain-specific empty/error states.
4. **P0—Review safety:** single-writer presentation, diff legibility, partial-work warning, conflict/commit/push recovery, and terminal capability gating.
5. **P1—Native shared core, then iPhone:** cached state, deep links/push, transcript parity, review, and real terminal.
6. **P1—iPad, then native Mac:** platform layouts, keyboard/pointer, restoration, windows, menus, and inspector behavior. Do not polish Catalyst as a substitute.
7. **P1—Public web:** rebuild only after capture-ready product states exist; marketing must show the shipped truth.
8. **P2—Settings/admin/billing long tail:** apply the same hierarchy and state rules after the canonical loop is excellent.

## Acceptance and review evidence

A surface passes craft review only with observable evidence:

- A seeded cross-device recording completes clone → session → goal → client exit → notification/return → diff → commit → push, with the same repo, branch, transcript, and state on web, iPhone, iPad, and Mac.
- Screenshot matrices cover 320, 390, 768, 1024, 1440, and 1920px; iPhone compact/large; iPad portrait/landscape/Stage Manager; Mac narrow/wide, light/dark, Increased Contrast, and maximum Dynamic Type. No clipped text, accidental horizontal page scroll, covered composer, or illegible shrink.
- A generated-content fixture contains 10k messages, a 10k-word answer, incomplete streaming Markdown, nested lists, wide table, links, 500-line code, attachments, reasoning, running/success/error tools, and Unicode. Selection, copy/Markdown copy, quote, share, collapse, scroll anchoring, restoration, and VoiceOver all work.
- State stories demonstrate every row in the state model, including 60-second network loss, duplicate/reordered events, auth expiry, concurrent-session lock, clone failure, conflict, rejected push, terminal unavailable/drop/exit, quota, and app kill. Each shows truthful persistence and a successful recovery path.
- Keyboard-only web/Mac and VoiceOver iPhone/iPad complete the canonical loop with visible focus and named controls. WCAG AA contrast holds; touch targets meet 44pt; Reduce Motion/Transparency produce no loss of meaning.
- Public claims are checked against enabled production capabilities. The landing's explanatory frames are pure CSS/SVG with inert controls and the seeded cast; any future raster capture follows the retired recapture requirements in `docs/PUBLIC-CAPTURE-PROVENANCE.md`.
- Review rejects any screen that substitutes polish for state truth, adds decoration without hierarchy, hides recovery, exposes raw implementation copy, or diverges in meaning across platforms.
