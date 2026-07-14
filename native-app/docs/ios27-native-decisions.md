# Waynode — iOS 27 Native Decisions

Companion to [iOS 27 native layout](ios27-native-layout.md). The layout guide
defines the screens and navigation; this document records implementation choices
and delivery order.

## What is not native or still needs a decision

1. **SwiftTerm vs a thin xterm.js-in-WKWebView** — SwiftTerm is the truly-native
   choice; WebView is a fallback if SwiftTerm lags a feature. Recommend SwiftTerm.
2. **TCA (The Composable Architecture) vs vanilla `@Observable`** — both work with
   Swift 6 strict concurrency. TCA gives testable state machines for the streaming
   reducers; vanilla is lighter. Recommend TCA for chat/terminal reducers at least.
3. **Markdown rendering** — Apple's `Text` supports CommonMark via
   `AttributedString(markdown:)`; code blocks need a custom block view. No
   third-party dependency is needed for the MVP.
4. **iPhone-only vs universal** — go **universal** from day one; the
   `.sidebarAdaptable` pattern makes iPad/Mac nearly free.

## Build order (1:1 with `PLAN.md` phases)

| Phase | Native deliverable |
|---|---|
| 0 (server plumbing) | Nothing native yet; validate API tokens end-to-end via curl |
| 1 | **AuthView + API token** + bare `SpacesScene` (read-only list) — proves transport |
| 2 | **ChatView** read + send + SSE streaming (no tool blocks yet) |
| 3 | Rich blocks (thinking/tool), model picker, goal pill |
| 4 | **TerminalView** (SwiftTerm over WS) + keybar accessory |
| 5 | **GitInspector** + **CloneSheet** + Live Activity for goals |
| 6 | Admin/Org/Space settings, polish, TestFlight |

## Summary for Francesco

- **One navigation codebase**: `TabView(.sidebarAdaptable)` gives a bottom bar on
  iPhone and a sidebar on iPad/Mac, matching the web's sidebar mental model.
- **Glass on chrome, matte on content**: standard tab bars, toolbars, input bar,
  and inspector receive Liquid Glass; chat messages, git diffs, and terminal
  output remain matte.
- **Primary action = `.glassProminent`** for Send, Clone, and Start Goal.
  Everything else uses `.glass`.
- **Survives being killed** means server-resident work plus APNs and a Live
  Activity in the Dynamic Island. The app controls and observes work; pi never
  runs on the phone.
- The icon is the three-layer Waynode mark in Icon Composer.

See [Apple Liquid Glass reference](apple-liquid-glass-reference.md) for the
underlying Apple guidance and [`PLAN.md`](../PLAN.md) for server additions and
the full roadmap.
