# Keyboard Interaction Contract — Waynode

Status: **Implemented (Phase A)** — audit + contract + terminal escape + modal Esc + mobile Enter done. Arrow history (Phase B) deferred.
Repo: `github.com/Fornace/waynode.git` (frontend: `frontend/src`)

This contract governs how Enter, Escape, and arrow keys behave across
Waynode's three key surfaces: the **xterm terminal** (a real PTY), the **chat
composer**, and **modals/overlays**. Goal: consistent, predictable ownership so
keys never do something surprising depending on what's focused.

---

## 0. Audit (current state, 2026-06-24, commit 5617d82)

### 0.1 Surfaces

| Surface | File | Keys handled | Current behavior |
|---|---|---|---|
| **Terminal** (xterm PTY) | `components/TerminalTab.tsx` | **none (custom)** | `new Terminal({...})` with **no `attachCustomKeyEventHandler`**. Every keystroke — including Esc, arrows, Enter, Ctrl+C — goes straight to the PTY over `/ws/terminal` via `term.onData`. The terminal captures all keys while focused. There is no escape hatch to the UI. |
| **Chat composer** | `components/ChatTab.tsx` `handleKeyDown` (l.205) | Enter, Shift+Enter | Bare Enter (`!e.shiftKey`): if `streaming` → queue follow-up, else send. `preventDefault` stops the newline. Shift+Enter → newline (browser default). No Esc, no arrows. Mobile: not special-cased — Enter sends on phone keyboards too (no soft-keyboard newline mode). |
| **Modals** | `SpaceSettings.tsx`, `RepoPicker.tsx`, `OrgSettings`, `AdminPanel` | none | `.modal-overlay` closes on **click-outside** (`onClick={onClose}`). **No Esc-to-close.** Close button only. |
| **Other inputs** | `LoginPage`, `RepoPicker` auth fields, `SpaceSettings` key fields | none | Plain inputs/textareas; browser default. |

### 0.2 Layout facts that shape the contract

- **Terminal and Chat are mutually exclusive tabs** in `SessionView`:
  `{activeTab === "chat" && <ChatTab/>}` / `{activeTab === "terminal" && <TerminalTab/>}`.
  They are conditionally mounted — only one is in the DOM at a time. So the
  terminal and the chat composer **never compete for the same keystroke**.
  The collision is terminal ↔ modals, and chat ↔ modals.
- **Only one keydown handler exists** in the whole frontend (`ChatTab`). There
  is no global key dispatcher; xterm manages its own input internally.
- Modals render on top (`.modal-overlay` is fixed/full-screen) but do **not**
  trap focus and do **not** listen for Esc.

### 0.3 Pain points / conflicts

1. **No way to escape the terminal to drive the UI via keyboard.** While the
   terminal is focused, Esc/arrows/Ctrl-* all go to the shell. If a modal is
   open behind the terminal (or the user wants to close the terminal tab /
   switch tabs by keyboard), there's no chord for it. Power users expect
   something like Ctrl+Shift+` or a "leader" key to leave the terminal surface.
2. **Modals don't close on Esc.** Every other app closes dialogs on Esc;
   Waynode requires a mouse click (overlay or ✕). Inconsistent and slower.
3. **Chat Enter behavior differs from terminal conventions.** Terminal users
   expect Enter to submit; the chat already does this (good) — but there's no
   arrow-key history recall, which a terminal-native user will reach for.
4. **Mobile multi-line input had no path.** Enter submits (correct, and the
   only working submit) but there was no way to type a newline on a phone —
   soft keyboards have no Shift. Fixed in Phase A by adding a ↵ button, not by
   repurposing Enter (which would have removed the only working submit).
5. **No global tab switch shortcut.** Switching Chat↔Terminal requires a mouse
   click on the tab button.

---

## 1. Ownership / precedence model (the contract)

Keys dispatch top-down; the first matching layer owns the event.

```
Layer 1 — Topmost modal/overlay (if any open)
          Esc closes it. While a modal is open, the terminal and chat are
          not the interaction target — modal gets Esc unconditionally.
Layer 2 — Focused surface
          • Terminal focused → keys go to PTY, EXCEPT a reserved
            "leave terminal" chord (Ctrl+Shift+T) which moves focus to the
            tab bar / chat, and Esc does NOT pass to the PTY when a modal
            is open (Layer 1 wins).
          • Chat composer focused → Enter/Shift+Enter per §1.2; Esc blurs
            the composer (returns focus to the message list).
Layer 3 — Global shortcuts (no modal, no input focused)
          Ctrl+Shift+T toggle Chat↔Terminal tab. Esc closes the sidebar if open.
Layer 4 — Browser default
```

### 1.1 Terminal keys

- **All keys route to the PTY** via `term.onData`, unchanged, **except**:
  - **Ctrl+Shift+T** (and Cmd+Shift+T on mac): intercepted via
    `term.attachCustomKeyEventHandler` → returns `false` (swallowed from PTY)
    and triggers tab switch / focus exit. This is the single reserved chord.
    Chosen because it's the browser "reopen tab" chord re-purposed only while
    the terminal owns focus, and it's unambiguous (Ctrl+Shift combos aren't
    sent to shells in practice).
- **When a modal is open (Layer 1):** the terminal should not receive input at
  all. The modal overlay will take focus on open (focus trap), so the terminal
  naturally loses `onData`. Esc then closes the modal.

### 1.2 Enter (chat composer)

| Context | Bare Enter | Shift+Enter | Newline button (↵) |
|---|---|---|---|
| Desktop chat | send (or queue if streaming) | newline | hidden |
| Mobile chat (soft keyboard) | **send (or queue)** | n/a (no Shift) | **shown — inserts newline at caret** |
| Chat while modal open | (modal owns Esc/Enter on its own inputs) | — | — |

- Decision: **Enter submits on every platform.** It is the one control that
  already works; we don't take it away. Instead, mobile gets an **extra ↵
  button** next to Send that inserts a newline at the caret, because soft
  keyboards have no Shift key. Detected via the shared `isTouchDevice()` helper.
- Desktop keeps single-Enter-to-send + Shift+Enter newline (no ↵ button shown).

### 1.3 Escape

| Context | Escape |
|---|---|
| Modal open | close topmost modal |
| Chat composer focused (no modal) | blur composer |
| Terminal focused (no modal) | pass to PTY (shell cancel) |
| Sidebar open (mobile) | close sidebar |

### 1.4 Arrow keys

- Terminal: pass to PTY (shell history/cursor). Unchanged.
- Chat composer: browser default (caret movement). **History recall via Up/Down
  at caret boundary is a reserved future enhancement** (§2 Phase B), not in the
  initial implementation.

---

## 2. Implementation plan (phased)

### Phase A — Modals + terminal escape (the reported pain)
1. **Shared `isTouchDevice()` helper** (`utils/device.ts`), computed once.
2. **Modal Esc-to-close:** a small `useEscapeToClose(onClose)` hook applied to
   `SpaceSettings`, `RepoPicker`, `OrgSettings`, `AdminPanel`. Add focus trap
   (focus the modal on open, restore on close) so terminal loses input while a
   modal is up.
3. **Terminal escape chord:** in `TerminalTab.tsx`, register
   `term.attachCustomKeyEventHandler` that returns `false` for Ctrl/Cmd+Shift+T
   and fires a callback to switch to the Chat tab; all other keys return `true`
   (PTY gets them). `TerminalTab` gains an `onRequestExit` prop wired to
   `setActiveTab("chat")` in `SessionView`.
4. **Global Ctrl+Shift+T** to toggle Chat↔Terminal when no input is focused
   (Layer 3), via a single `useEffect` keydown listener in `SessionView`.

### Phase B — History (later)
5. Chat Up/Down prompt history (per-session ring, persisted with the session).
   (The mobile newline button from Phase A replaces the earlier "mobile
   Enter=newline" idea, which would have removed the only working submit.)

### Phase C — (only if needed)
A real focus-trap / z-index overlay registry if more surfaces appear.

---

## 3. Verification checklist (before goal complete)

- [x] Audit (§0) accurate for Waynode commit 5617d82.
- [x] Contract (§1) written.
- [x] Phase A.2: Esc closes all four modals/panes; focus trapped while open (SpaceSettings, RepoPicker; panes OrgSettings/AdminPanel use Esc without trap).
- [x] Phase A.3: Ctrl/Cmd+Shift+T inside the terminal switches to Chat tab; all other keys still reach the PTY (via `attachCustomKeyEventHandler`).
- [x] Phase A.4: global Ctrl/Cmd+Shift+T toggles Chat↔Terminal when no input/terminal focused.
- [x] `isTouchDevice` helper extracted (`utils/device.ts`); used to show the mobile ↵ newline button. Enter-to-send preserved on all platforms.
- [x] `tsc -b && vite build` passes.
- [ ] Manual smoke (terminal typing unaffected; Esc closes modals; chord exits terminal; chat Enter still sends on desktop) — pending deploy.
- [ ] Phase B (chat Up/Down prompt history) — deferred.
