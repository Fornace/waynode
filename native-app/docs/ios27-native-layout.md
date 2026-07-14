# Waynode — iOS 27 Native Layout
### Liquid Glass, fully native, replicating the web UX

> Companion to `apple-liquid-glass-reference.md`. This document maps **every screen
> of the current web app** (`frontend/src/`) to a **fully native iOS 27 / iPadOS 27
> / macOS 27** realization that privileges Apple's Human Interface Guidelines and
> uses the real Liquid Glass APIs (verified present in our Xcode 27 SDK).
>
> Target toolchain (installed on this Mac): **Xcode 27.0 beta, Swift 6.4**.
> Last grounded against Apple docs: **2026-07-06**.

---

## 0. The one structural decision (read first)

The web app is: **collapsible Sidebar** (Org → Spaces → Sessions) + **SessionView**
(model picker, Chat/Terminal tabs, Git sidebar). That's a classic **primary +
secondary + content** hierarchy — and iOS 27 has a first-class answer for it:

```
                iPhone              iPad / Mac (same code)
            ┌──────────────┐    ┌─────────┬──────────┬─────────┐
  top layer │  TabView     │    │ Sidebar │ Content  │ Inspector│  ← Liquid Glass
  (glass)   │  (4 tabs)    │    │ (adapts │          │ (Git)    │
            ├──────────────┤    │  from   │          │          │
  content   │  per-tab     │    │  tabbar)│          │          │
  layer     │  stack       │    │         │          │          │
            └──────────────┘    └─────────┴──────────┴─────────┘
```

**Rule (HIG):** navigation is the *functional layer* (Liquid Glass); chat/git/code
is the *content layer*. We never paint a glass effect on content.

**Implementation:**
```swift
TabView(selection: $selectedTab) {
    Tab("Spaces",  systemImage: "square.stack.3d.up")     { SpacesScene() }
    Tab("Session", systemImage: "bubble.left.and.bubble.right") { SessionScene() }
    Tab("Terminal",systemImage: "terminal")                { TerminalScene() }
    Tab("Account", systemImage: "person.crop.circle")     { AccountScene() }
}
.tabViewStyle(.sidebarAdaptable)   // ← iPhone: bottom bar, iPad/Mac: sidebar. Apple-blessed.
```

This single pattern replaces the web's manual `sidebarOpen` state + collapsible
drawer. On iPhone you get a bottom glass tab bar; on iPad/Mac the *same tabs*
become a glass sidebar automatically. We write navigation **once**.

---

## 1. Design tokens (mapping web → native)

The web is a deliberately dark, low-chrome product. We keep the *identity* but
express it through **system materials**, not hardcoded hex.

| Web (CSS var) | Native equivalent | Notes |
|---|---|---|
| `--bg #0a0a0b` | `Color(.systemBackground)` + `.preferredColorScheme(.dark)` | Let the OS own black; supports light mode too |
| `--bg-surface #111113` | `Material.regular` / `.background(.regularMaterial)` | **Glass**, not opaque — the whole point |
| `--bg-elevated #1c1c1f` | `.background(.thickMaterial)` in a sheet/popover | |
| `--accent #3b82f6` | `Color.accentColor` (= Waynode blue) | Configure once in asset catalog w/ light+dark+HC |
| `--green/amber/red` | `.green/.orange/.red` semantic SF symbols | Status: done/running/error |
| `--text-dim #9ca3af` | `.foregroundStyle(.secondary)` / `.tertiary` | Semantic, not hex |
| Message bubble bg | `Material.ultraThin` *only if needed*; prefer plain rows | See §4 — bubbles are content, not glass |

**App icon:** the Waynode mark (`Brand.tsx`) — central node + four radiating paths —
decomposes into 3 layers for **Icon Composer**:
- Background: solid field (brand blue → tintable)
- Middle: four radiating "way" bars
- Foreground: central hub node + 4 endpoint dots

---

## 2. Screen map (web component → native scene)

| Web component | Native scene | Primary container |
|---|---|---|
| `Sidebar.tsx` | **SpacesScene** (`NavigationStack` + `List`) | Tab 1 |
| `RepoPicker.tsx` | **CloneSheet** (`.sheet`) | Modal |
| `SessionView.tsx` (chat) | **SessionScene** chat tab | Tab 2 content |
| `ChatTab.tsx` | **ChatView** | Scroll + input bar |
| `TerminalTab.tsx` | **TerminalView** (SwiftTerm / xterm.js-equivalent) | Tab 3 |
| `GitSidebar.tsx` | **GitInspector** (`NavigationSplitView` inspector) | Split column 3 |
| `AdminPanel.tsx` / `OrgSettings.tsx` | **AdminView** / **OrgSettingsView** (`Form`) | Tab 4 / sheets |
| `SpaceSettings.tsx` | **SpaceSettingsView** (`Form`) | Sheet from SpacesScene |
| `LoginPage` / `InvitePage` | **AuthView** (ASWebAuthenticationSession → API token) | Full-screen |

---

## 3. SpacesScene — the navigation root (replaces Sidebar)

**Web:** `Sidebar.tsx` — org switcher, expandable spaces, sessions per space,
session context menu (archive / delete / merge-and-archive), admin & org settings,
clone button, user menu.

**Native (HIG-first):**

```
NavigationStack {
  List(selection: $navPath) {
    // ── Org switcher ──
    Section { OrgPickerRow(activeOrg) }            // → Menu, not a custom dropdown
    
    // ── Spaces ──
    Section("Spaces") {
        ForEach(spaces) { space in
            DisclosureGroup(space.repoName) {       // expandable = native
                ForEach(space.sessions) { sess in
                    SessionRow(sess)                // swipe actions: archive, delete
                        .contextMenu { … }          // merge+archive, rename
                }
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { delete(space) } label: { Label("Delete", "trash") }
            }
        }
    }
  }
  .navigationTitle("Waynode")
  .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
          Button { showClone = true } label: { Image(systemName: "plus") }
              .buttonStyle(.glass)                  // ← Liquid Glass
      }
  }
}
.sheet(isPresented: $showClone) { CloneSheet() }
```

**HIG points applied:**
- **Swipe actions** (archive/delete) instead of hover context menus — the iOS-native
  way to expose per-row actions (web's right-click menu equivalent).
- `.contextMenu` for the less-common "merge-and-archive".
- `OrgPickerRow` uses a standard `Menu` (glass popover) — never a custom dropdown.
- The "+" clone button is `.buttonStyle(.glass)` — a single secondary glass control
  in the toolbar, exactly as Apple intends.

**Cold-launch continuity (from `PLAN.md`):** on appear, `SpacesScene` rehydrates
from the server (`GET /api/spaces` + `GET /api/sessions`) — *not* from local state.
Work survives the app being killed because the server owns it; the app is a view.

---

## 4. SessionScene / ChatView — the heart (replaces ChatTab)

**Web (`ChatTab.tsx`):** message list (user / assistant / system), rich `Block`s
(text / thinking / tool-with-status), SSE streaming, send / stop / newline buttons,
file upload, **goal mode** send, model picker in header.

**Native:** this is the *content layer*. Per HIG, **content stays matte** — we do
**not** glass the message rows. Glass is reserved for the input bar + toolbar.

```
SessionScene {
  VStack(spacing: 0) {
      // ── Toolbar (FUNCTIONAL layer → Liquid Glass) ──
      ModelGoalBar(model, goal)                     // model Menu + goal status pill
          .background(.bar)                          // system bar = glass + scroll edge

      // ── Content layer (matte, scrolls under the glass bar) ──
      ScrollViewReader { proxy in
          List {                                     // streaming-friendly
              ForEach(messages) { msg in MessageRow(msg) }
          }
          .listStyle(.plain)
          .scrollEdgeEffectStyle(.hard)             // legibility as content scrolls under bar
      }

      // ── Input bar (FUNCTIONAL layer → Liquid Glass) ──
      MessageInputBar(text, isStreaming, isGoal)
          .background(.regularMaterial)             // glass input dock
          .safeAreaInset(edge: .bottom)
  }
}
```

### Message row → native

| Web block | Native rendering |
|---|---|
| `user` message | trailing-aligned plain text (no bubble, or `Color(.secondarySystemBackground)` subtle row) |
| `assistant` text block | `Text` with Markdown via `.textSelection(.enabled)` (code blocks monospaced) |
| `thinking` block | collapsed `DisclosureGroup` with dimmed `.secondary` text + brain SF symbol |
| `tool` block | a compact **ToolResultCard**: icon + name + status badge + expandable output |
| `system` message | small centered `.tertiary` caption |
| streaming | append to last assistant row; show a `ProgressView` while `done == false` |

Status badges use semantic SF symbols on semantic colors:
- `running` → `clock` `.orange`
- `done` → `checkmark.circle.fill` `.green`
- `error` → `xmark.circle.fill` `.red`

### Message input bar (the glass dock)

```
HStack {
    Button { attach() } label: { Image(systemName: "paperclip") }
        .buttonStyle(.glass)                        // secondary glass
    TextField("Message pi…", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
    // NEWLINE: on iOS a real keyboard — no button needed (web needed it for mobile)
    if isStreaming {
        Button { abort() } label: { Image(systemName: "stop.fill") }
            .buttonStyle(.glass)
    } else {
        Button { send() } label: { Image(systemName: "arrow.up") }
            .buttonStyle(.glassProminent)           // ← PRIMARY action = prominent glass
            .disabled(draft.isBlank)
    }
}
.padding()
.background(.regularMaterial)                       // ← the glass dock
```

**Goal mode:** a toggle `Button { isGoal.toggle() }` (`.buttonStyle(.glass)`,
tinted `.accentColor` when on) sitting left of the input — label `target` SF symbol.
When on, `send()` hits the goal endpoint. While a goal is active, `ModelGoalBar`
shows a tappable **goal pill** (objective + token usage + elapsed) that opens a
**GoalDetailSheet** with live progress — this is also where a Live Activity can be
pinned (see §8).

**File upload:** `paperclip` → `.photosPicker` (Photos) + `UIDocumentPicker` (repo
files). Native pickers, no custom file dialog.

---

## 5. TerminalView — full TUI over WebSocket (replaces TerminalTab)

**Web:** xterm.js over WebSocket, mobile keybar (tap Ctrl then a letter), resize,
reconnect, busy/disabled guards, lazy-loaded.

**Native:** use **SwiftTerm** (open-source, Apple-style terminal emulator for
SwiftUI/UIKit) wired to the existing `/api/terminal` WebSocket.

```
TerminalView(term)                              // SwiftTerm view
    .onResize { cols, rows in ws.send(.resize) }
    .toolbar {
        ToolbarItemGroup(placement: .keyboard) {
            // the mobile keybar, reborn as a native accessory view
            Keybar(ctrlArmed: $ctrlArmed) {
                Button("Ctrl") { ctrlArmed.toggle() }.buttonStyle(.glass)
                // … esc, tab, arrows, common combos
            }
        }
    }
```

- **Keyboard accessory** (`ToolbarItemGroup(placement: .keyboard)`) replaces the
  web's custom on-screen keybar — and it's glass by default. Extra-large control
  size (new in iOS 27) gives finger-friendly tap targets.
- **Busu/disabled states** → `ContentUnavailableView` (Apple's native empty/error
  surface) when `piBusy` or session mutex blocks the terminal.
- **Reconnect** → standard retry with `.progressView`.

HIG note: a terminal is *content*, so it's matte; only the keybar accessory is glass.

---

## 6. GitInspector — the third column (replaces GitSidebar)

**Web (`GitSidebar.tsx`):** branch + ahead/behind, uncommitted files (porcelain),
commits list, branches list, `piBusy` guard. Toggleable panel.

**Native:** on iPad/Mac this is the **inspector** of a `NavigationSplitView`; on
iPhone it's a `.sheet` from the SessionScene toolbar.

```
NavigationSplitView {
    SessionScene()                                // content
} detail: {
    // (chat/terminal handled inside SessionScene)
} inspector(isPresented: $gitOpen) {
    GitInspectorView(snapshot)                    // Form with sections
}
```

`GitInspectorView`:
- **Section "Branch"** — current branch, ahead/behind chips, `piBusy` warning banner
  (`ContentUnavailableView` if busy).
- **Section "Changes"** — `List` of `GitFile`s with SF-symbol status icons (M/A/D/…)
  and +/− diff counts. Swipe to stage.
- **Section "Commits"** — `List` of recent commits (short hash + subject + relative date).
- **Section "Branches"** — `List` with the default branch pinned.

All lists use standard `List` rows — **content layer, matte**. The inspector chrome
itself is glass automatically because it's a system inspector.

---

## 7. CloneSheet — adding a space (replaces RepoPicker)

**Web (`RepoPicker.tsx`):** search GitHub/GitLab repos, groups by owner, paste URL,
branch, auth token; SSE clone-progress stream.

**Native:** a `.sheet` with a `Form`:
- `TextField` for repo URL (with `.keyboardType(.URL)`, `.textContentType(.URL)`).
- `TextField` for branch (default `main`).
- A "Pick from GitHub/GitLab" button → pushes a `RepoSearchView` (`List` grouped by
  owner, same data shape as web `RepoGroup`) using `.searchable`.
- **Clone progress** → `ProgressView` driven by the existing SSE clone-events stream
  (`EventSource` → native `URLSession` bytes). Show log lines in a `TextEditor`-like
  console inside the sheet.

Primary "Clone" button → `.buttonStyle(.glassProminent)`.

---

## 8. Notifications & Live Activities (the "survives being killed" layer)

Per `PLAN.md`: **work is server-resident.** The native app observes it; it doesn't
run it. So when iOS kills the app, pi keeps working on the server. We surface that
through Apple-native surfaces:

### 8.1 Live Activity (ActivityKit) — for an active goal
When a goal is running, start an ActivityKit **Live Activity**:
```
┌───────────────────────────────────────┐
│ ▎ Waynode · building feature X   42%  │  ← Dynamic Island / Lock Screen
│ ▎ tokens 12k/40k · 3m elapsed          │
└───────────────────────────────────────┘
```
- Expands in Dynamic Island on iPhone; sits on Lock Screen.
- Updated by APNs push (server → APNs → ActivityKit update token) — **works when
  the app is killed**, because the system renders it, not the app.
- Tap → deep-links into the session.

### 8.2 APNs push — milestone + completion
Server hooks into the existing `handle.broadcast()` seam and dispatches APNs:
- "Goal complete" → notification → tap reopens SessionScene with final state.
- "Needs your input" → high-priority push.
- "Goal budget limited" → informational push.

### 8.3 Cold-launch rehydration
On launch, `SessionScene` calls `GET /api/sessions/:id/messages` and rehydrates the
full transcript from disk JSONL on the server. The app never depends on having been
alive during the work — **it catches up from the server of truth.**

---

## 9. AccountScene + Admin (replaces AdminPanel / OrgSettings / user menu)

**Web:** user menu (logout), AdminPanel, OrgSettings, SpaceSettings.

**Native:** Tab 4 = **AccountScene**, a `Form`:
- User card (avatar + name + email) from `User`.
- "Spaces", "Sessions" quick counts.
- **Org Settings** push (admin only) → `OrgSettingsView` (`Form` with members, roles).
- **Admin** push (admin only) → `AdminView` (`Form`/`List`).
- Per-space **Space Settings** sheet (from SpacesScene) → secrets, members, delete.
- **Sign out** → `.buttonStyle(.borderedProminent)` red-tinted, or standard.

`Form` is the HIG-native settings container — glass sections on grouped background,
free of charge.

---

## 10. Auth (replaces LoginPage / InvitePage)

- **`ASWebAuthenticationSession`** to run the existing GitHub/GitLab OAuth flow
  (reuses server `/auth/github/callback`), capturing the session.
- **Exchange session → API token** (the `api_tokens` table from `PLAN.md` Phase 0)
  so the native client uses Bearer auth for REST/SSE/WS — independent of the
  session cookie, survives relaunch.
- **InvitePage** → deep link handler (`waynode://invite/<token>`) → `LinkPresentation`
  + the same ASWebAuthenticationSession to accept.

---

## 11. Component→API wiring (parity checklist)

| Web (`api/client.ts`) | Native call | Transport |
|---|---|---|
| `auth.me()` | `GET /api/auth/me` | Bearer |
| `spaces.list/create/delete/pull` | same paths | Bearer |
| `sessions.list/get/create/delete/archive/rename` | same | Bearer |
| `sessions.setModel` | `POST /api/sessions/:id/model` | Bearer |
| `sessions.getGoal` | `GET /api/sessions/:id/goal` | Bearer, polled while active |
| `POST /api/sessions/:id/message` | same | Bearer, fire-and-forget |
| `/stream` (SSE) | `URLSession.bytes(for:)` SSE lines | Bearer (or `?t=` token) |
| `/api/terminal` (WS) | `URLSessionWebSocketTask` | Bearer/token subprotocol |
| clone-events SSE | `URLSession.bytes` | Bearer |

All transport types map 1:1 to native Foundation primitives. No new server contract
beyond the Phase-0 additions in `PLAN.md` (api_tokens + push_devices + APNs).

---

## 12. Decisions and delivery sequence

The remaining native-vs-web decisions, phased build order, and implementation
summary live in [iOS 27 native decisions](ios27-native-decisions.md).
