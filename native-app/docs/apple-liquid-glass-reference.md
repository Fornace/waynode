# Apple Liquid Glass — Local Reference (iOS 27 / macOS 27 / WWDC26)

> **Grounded 2026-07-06.** Rewritten locally from Apple's authoritative sources so
> the Waynode native apps team doesn't need to re-fetch JS-rendered DocC pages.
> Sources are cited inline. Re-verify against the live docs before each major
> release — Apple revises these between seeds.

## Sources (all current as of 2026-07-06)

| What | Where |
|------|-------|
| Liquid Glass overview | https://developer.apple.com/documentation/technologyoverviews/liquid-glass |
| **Adopting Liquid Glass** (the big one) | https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass |
| App design and UI | https://developer.apple.com/documentation/technologyoverviews/app-design-and-ui |
| WWDC26 sessions | https://developer.apple.com/videos/wwdc2026 |
| Local toolchain | **Xcode 27.0 beta** (`/Applications/Xcode-beta.app`), Swift 6.4, iOS 27 SDK installed ✅ |
| Structured JSON graph (scrape-proof fallback) | `https://developer.apple.com/tutorials/data/documentation/<path>.json` |

> ⚠️ `developer.apple.com` DocC pages are **JS-rendered and scraper-blocked** (spider
> chrome mode + `ctx_url_read` both return only the title). The reliable machine
> path is the **tutorials data graph JSON** (`/tutorials/data/documentation/…`),
> which returns the full structured content. Use that for any future re-grounding.

---

## 1. What Liquid Glass is

> "Interfaces across Apple platforms feature a new dynamic material called **Liquid
> Glass**, which combines the optical properties of glass with a sense of fluidity.
> This material forms a **distinct functional layer for controls and navigation
> elements**. It affects how the interface looks, feels, and moves, adapting in
> response to a variety of factors to help bring focus to the underlying content."
> — *Introduction to Liquid Glass*, Apple

**Core idea:** there are now **two layers** in every interface:

1. **Content layer** — your app's actual content (chat messages, a code file, a diff).
2. **Functional layer** — Liquid Glass. The floating navigation + controls that sit
   *above* content: tab bars, toolbars, sidebars, floating buttons. They refract and
   adapt to whatever scrolls beneath them.

Liquid Glass is **not a paint color**. It is a real-time optical material: it
refracts, reflects, blurs, and morphs based on what's under it, the focus state,
and accessibility settings. Treat it as a system-owned surface, not something you
draw.

### Design principles (Apple's words, condensed)

- **Establish hierarchy.** Navigation is *distinct* from content. Never blur the
  line — the glass layer floats; content sits underneath.
- **Create harmony.** Rounded, concentric shapes that nest into the hardware's
  curvature. Controls are rounder now because device corners are round.
- **Maintain consistency.** Use standard components so your app looks at home.
- **Be judicious with color** in controls and navigation so they stay legible and
  let content "infuse them and shine through."

---

## 2. The adoption playbook (this is the part that matters for us)

Apple's explicit guidance for existing apps — applies directly to Waynode (we are
porting an existing product, not starting fresh):

### 2.1 Leverage system frameworks → adopt automatically
> "In system frameworks, standard components like bars, sheets, popovers, and
> controls automatically adopt this material… with minimal code by using standard
> components from SwiftUI, UIKit, and AppKit."

**For us:** use `NavigationStack` / `NavigationSplitView`, `.tabViewStyle`, standard
`Toolbar`, `Button`, `List`, `Form`, `Sheet`. They get Liquid Glass for free. Don't
reimplement a "glassy" custom tab bar.

### 2.2 Reduce custom backgrounds in controls & navigation
> "Any custom backgrounds and appearances you use in these elements might overlay
> or interfere with Liquid Glass or other effects that the system provides, such as
> the **scroll edge effect**. Prefer to remove custom effects and let the system
> determine the background appearance."

Elements to audit: **split views, tab bars, toolbars.**

**For us:** the web app uses explicit `--bg-surface: #111113` panels. On native,
**do not** recreate those opaque dark panels for navigation. Let the glass layer be
glass. Reserve explicit backgrounds for *content* surfaces (a code block, a message
bubble) — not for chrome.

### 2.3 Avoid overusing Liquid Glass
> "If you apply Liquid Glass effects to a custom control, do so sparingly…
> overusing this material in multiple custom controls can provide a subpar user
> experience by distracting from that content. Limit these effects to the most
> important functional elements."

**For us:** Liquid Glass belongs on **the send button, the tab bar, the sidebar,
toolbars, floating action buttons.** It does *not* belong on every message bubble,
every tool-result card, every list row. Those are content.

### 2.4 Test with accessibility settings
People can choose a preferred Liquid Glass look, or enable **Reduce Transparency**
or **Reduce Motion**. These settings "remove or modify certain effects." Standard
components adapt automatically; custom glass elements must be tested under all of:
default, dark, increased contrast, reduce transparency, reduce motion.

### 2.5 The scroll edge effect (legibility)
> "Scroll views offer a **scroll edge effect** that helps maintain sufficient
> legibility and contrast for controls by obscuring content that scrolls beneath
> them. System bars like toolbars adopt this behavior by default."

If you build a custom bar, register it for the scroll edge effect. On native this
means using `.scrollEdgeEffectStyle(...)` / standard `safeAreaInset` bars rather
than a custom overlay.

### 2.6 Concentric, rounded shapes
> "The shape of the hardware informs the curvature, size, and shape of nested
> interface elements, including controls, sheets, popovers, windows."
> Use rounded shapes **concentric to their containers**.

**For us:** corner radii should nest (e.g. a button's radius relates to the card
it sits in, which relates to the sheet). Use `RoundedRectangle(cornerRadius:)`
with the system's `ContinuousRectangleCornerStyle`, not arbitrary pixel values.

### 2.7 New button styles
> "Instead of creating buttons with custom Liquid Glass effects… adopt the look
> and feel of the material with minimal code by using one of the following button
> style APIs."

Confirmed present in our **iOS 27 SwiftUI SDK** (`arm64e-apple-ios.swiftdoc`):

```
GlassButtonStyle            // standard glass button
GlassProminentButtonStyle   // emphasized / primary action (filled accent)
.glassProminent(...)        // modifier to promote a control
GlassVariant                // variant enum (e.g. regular / prominent)
glassBackgroundEffect       // apply glass to a *custom* surface (use sparingly!)
.glassy(...)                // convenience
```

→ **Primary action (Send, Clone, Start Goal) = `.buttonStyle(.glassProminent)`.**
→ **Secondary controls = `.buttonStyle(.glass)`.**
→ Reserve `glassBackgroundEffect` for at most one or two hero custom surfaces.

### 2.8 Navigation: tab bar → sidebar adaptation
> "Liquid Glass applies to the **topmost layer** of the interface, where you define
> your navigation. Key navigation elements like [tab bars, sidebars] float in this
> Liquid Glass layer."
> "Consider adapting your tab bar into a sidebar automatically… depending on context."

**For us:** this is the single most important structural decision (see layout doc).
On iPhone → `TabView`. On iPad/Mac → the *same* `TabView` with
`.tabViewStyle(.sidebarAdaptable)` automatically becomes a sidebar. One codebase,
platform-correct navigation. This is the Apple-blessed pattern for 2026.

### 2.9 Background extension effect (edge-to-edge)
> "Creates a sense of extending a background under a sidebar or inspector, without
> actually scrolling or placing content under it. Mirrors the adjacent content…
> applies a blur to maintain legibility. Perfect for hero images."

Use sparingly for hero content (e.g. a repo's cover / README banner). Not for chat.

### 2.10 Tab bar minimization (iOS)
> "Tab bars can help elevate the underlying content by receding when a person
> scrolls up or down. You can opt into this behavior."

Opt in for the chat scroll view so messages get maximal vertical space.

---

## 3. App icons (Icon Composer)

- App icons are now **layered**: background, middle, foreground.
- The system applies reflection, refraction, shadow, blur, highlights to your layers.
- iOS/iPadOS/macOS ship **default (light), dark, clear, and tinted** variants.
- Design in **Icon Composer** (in Xcode 27 / downloadable).
- **Waynode mark** already decomposes naturally into layers: the central node hub
  (foreground), the four radiating paths (middle), a solid field (background). See
  `frontend/src/components/Brand.tsx` for the geometry.

---

## 4. Controls refresh (sliders, toggles, segmented, menus)

- Sliders/toggles: the **knob transforms into Liquid Glass during interaction**.
- Menus/popovers morph fluidly.
- Controls adopt **rounder forms** to nest into corners.
- New **extra-large size** option for controls (more space for labels/accents) —
  useful for the terminal keybar on iPhone.
- **Segmented control** refreshed — relevant for Chat ⟷ Terminal tab switching.

---

## 5. iPadOS / macOS specifics

- iPadOS gets a **menu bar** for fast access to common commands (like macOS).
- Split views (`NavigationSplitView`) are the blessed sidebar+inspector pattern.
- Audit safe-area compatibility for content adjacent to sidebars/inspectors.

---

## 6. Anti-patterns to avoid (Apple says so)

| Don't | Why |
|-------|-----|
| Custom-draw a "glassy" tab bar / toolbar | Conflicts with the real material + scroll edge effect |
| Stack/overlap multiple Liquid Glass controls | Distracting, illegible |
| Apply glass to every card / row / bubble | Overuse → subpar UX. Glass is for *functional* layer only |
| Hard-code control spacing / metrics | Breaks when shapes/sizes change per seed |
| Put custom backgrounds under standard bars | Hides the scroll edge effect |
| Ignore Reduce Transparency / Reduce Motion | Standard components adapt; custom must be tested |

---

## 7. How to re-ground (for future agents)

1. Don't scrape `developer.apple.com` HTML — it's JS-rendered and blocked.
2. Fetch the **data graph JSON**: `curl https://developer.apple.com/tutorials/data/documentation/<path>.json`
   - e.g. `technologyoverviews/adopting-liquid-glass`
   - extract with: `grep -aoE "\"(text|title)\":\"[^\"]{12,}\"" file.json`
3. Confirm SDK symbols from the installed toolchain:
   `grep -aoE "[A-Za-z]*[Gg]lass[A-Za-z]+" /Applications/Xcode-beta.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-ios.swiftdoc`
4. This Mac has **Xcode 27.0 beta + Swift 6.4** — build against it directly.

---

*Doc written by the Waynode native-apps track. Keep in sync with the layout doc
(`./ios27-native-layout.md`) which applies these rules to our actual screens.*
