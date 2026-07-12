# Content hub: guides, comparisons, and agent-readable endpoints

Waynode serves a public content hub designed for both classic SEO and AI answer
engines (AEO/GEO). Everything is server-rendered by `routes/content.js`; no
SPA JavaScript is needed to read it, which is what AI crawlers require.

## Where articles live

`content/articles/*.md`, one file per article, with `---` frontmatter:

```
---
title: Waynode vs GitHub Codespaces
description: One-sentence summary (~150 chars, used in meta description and indexes)
category: compare | guides
slug: waynode-vs-github-codespaces
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: comma, separated, target queries
---
```

Files are cached by mtime: edit a file and the next request re-reads it, no
restart needed.

## URL surface

| Path | What |
|------|------|
| `/learn` | Hub index (all guides + comparisons) |
| `/compare/<slug>`, `/guides/<slug>` | Article HTML with Article/FAQPage/Breadcrumb JSON-LD |
| any page + `.md` | Raw markdown twin (the Resend pattern) |
| `Accept: text/markdown` on any article/hub URL | Content-negotiated markdown at the same URL |
| `/index.md` | The home page as markdown for agents (source: `content/index.md`) |
| `/llms.txt` | llms.txt-standard index of all agent-readable pages |
| `/llms-full.txt` | Every article concatenated for one-shot ingestion |
| `/robots.txt` | Allows all crawlers, `Content-Signal: ai-train=yes, search=yes, ai-input=yes`, sitemap pointer |
| `/sitemap.xml` | All content URLs |

Every `.md` response is prefixed with a pointer to `/llms.txt` so an agent
landing on one page can discover the rest.

## Article conventions (why they look the way they do)

- Definitive 2–3 sentence answer immediately after the H1, then a TL;DR, because
  LLMs cite the top of the page far more than the middle.
- Question-shaped H2s, each section self-contained, because answer engines retrieve
  chunks, not pages.
- A `## FAQ` section with `### question` subsections at the end, parsed into
  FAQPage JSON-LD automatically by `routes/content.js`.
- Comparison tables, concrete numbers, and source links for all competitor
  claims; neutral declarative tone (promotional language measurably lowers
  LLM citation rates).
- Competitor facts must be verified against live pages when written or
  updated, never from a model's memory. Bump `updated:` when you touch a page.
- No em dashes anywhere. Use a comma, colon, period, or parentheses instead;
  for title separators use ":" or "|".
- No other machine-writing tells (list measured in the eu-sovereign-ai style
  eval): no Kobak focal words (delve, robust, seamless, leverage, pivotal,
  landscape, journey, harness, utilize, and the rest of that set); no
  correlative filler ("not only X but Y", "it's not just X, it's Y"); no
  bold-label bullet scaffolding where the label adds nothing; no "&" in
  titles; no hedge-and-reassure stacking. If removing a phrase changes
  nothing, remove it.
- Cover images live in `frontend/public/covers/<slug>.png` (16:9), referenced
  by `cover:` frontmatter and prepended to the body. They are generated with
  the same locked pipeline as trendwalker-sentia: model
  `gemini-3.1-flash-image-preview` via `generateContent`, using sentia's exact
  Bauhaus prompt template (see `.cursor/rules/image-generation.mdc` in that
  repo). Do not restyle or embellish the prompt.
