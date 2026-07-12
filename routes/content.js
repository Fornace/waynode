// Public content hub: guides + comparison articles, served as real
// server-rendered HTML (no SPA JS needed) with a raw-markdown twin for every
// page, plus llms.txt / llms-full.txt / index.md for AI agents and crawlers.
//
// Articles live in content/articles/*.md with a simple `---` frontmatter
// block (title, description, category, slug, date, updated, keywords).
// Files are read at startup and re-read when their mtime changes, so edits
// show up without a restart.

import express from "express";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { marked } from "marked";
import { config } from "../lib/config.mjs";

const router = express.Router();
const CONTENT_DIR = "./content/articles";
const HOME_MD = "./content/index.md";

const CATEGORIES = {
  compare: { label: "Comparisons", blurb: "How Waynode differs from other coding-agent tools, feature by feature." },
  guides: { label: "Guides", blurb: "Practical guides to self-hosted, persistent coding-agent workspaces." },
};

function siteUrl() {
  return (config.appUrl || "http://localhost:3000").replace(/\/$/, "");
}

// --- loading -----------------------------------------------------------

function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const meta = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, "") };
}

const cache = new Map(); // filename -> { mtimeMs, article }

function loadArticle(file) {
  const path = join(CONTENT_DIR, file);
  const mtimeMs = statSync(path).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.article;

  const raw = readFileSync(path, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const slug = meta.slug || file.replace(/\.md$/, "");
  const category = CATEGORIES[meta.category] ? meta.category : "guides";
  const article = {
    slug,
    category,
    title: meta.title || slug,
    description: meta.description || "",
    date: meta.date || "",
    updated: meta.updated || meta.date || "",
    keywords: meta.keywords || "",
    author: meta.author || "",
    body,
    raw,
    html: marked.parse(body),
    path: `/${category}/${slug}`,
  };
  cache.set(file, { mtimeMs, article });
  return article;
}

function allArticles() {
  if (!existsSync(CONTENT_DIR)) return [];
  return readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map(loadArticle)
    .sort((a, b) => (a.category === b.category ? a.title.localeCompare(b.title) : a.category.localeCompare(b.category)));
}

function findArticle(category, slug) {
  return allArticles().find((a) => a.category === category && a.slug === slug) || null;
}

// --- FAQ extraction for JSON-LD ---------------------------------------
// Articles put questions under `## FAQ` as `### Question` + answer paragraphs.
// The format is ours and machine-authored, so structural parsing is safe.

function extractFaq(body) {
  const faqIdx = body.search(/^## +(FAQ|Frequently asked questions)/im);
  if (faqIdx === -1) return [];
  const section = body.slice(faqIdx).split(/\n## +(?!#)/)[0];
  const parts = section.split(/^### +/m).slice(1);
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    return {
      q: p.slice(0, nl).trim(),
      a: p.slice(nl + 1).trim().split(/\n{2,}/)[0].trim(),
    };
  }).filter((f) => f.q && f.a);
}

// --- HTML template ------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const PAGE_CSS = `
  :root { --bg:#0a0a0b; --surface:#111113; --border:rgba(255,255,255,.12); --text:#f3f4f6; --dim:#9ca3af; --accent:#3b82f6; --green:#10b981; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  header.site { display:flex; align-items:center; justify-content:space-between; padding:18px 24px; border-bottom:1px solid var(--border); }
  header.site .brand { color:var(--text); font-weight:700; font-size:17px; }
  header.site nav a { color:var(--dim); margin-left:18px; font-size:14px; }
  main { max-width:760px; margin:0 auto; padding:48px 24px 80px; }
  .crumbs { font-size:13px; color:var(--dim); margin-bottom:24px; }
  .meta { color:var(--dim); font-size:14px; margin:8px 0 32px; }
  article h1 { font-size:34px; line-height:1.2; letter-spacing:-.02em; }
  article h2 { font-size:24px; margin:40px 0 12px; letter-spacing:-.01em; }
  article h3 { font-size:18px; margin:28px 0 8px; }
  article p, article li { color:#d1d5db; margin:12px 0; }
  article ul, article ol { padding-left:24px; }
  article code { background:var(--surface); border:1px solid var(--border); border-radius:5px; padding:1px 5px; font-size:.9em; }
  article pre { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; overflow-x:auto; margin:16px 0; }
  article pre code { border:0; background:none; padding:0; }
  article table { border-collapse:collapse; width:100%; margin:20px 0; font-size:14.5px; display:block; overflow-x:auto; }
  article th, article td { border:1px solid var(--border); padding:9px 12px; text-align:left; vertical-align:top; }
  article th { background:var(--surface); }
  article blockquote { border-left:3px solid var(--accent); padding-left:16px; color:var(--dim); margin:16px 0; }
  .mdlink { margin-top:48px; padding-top:20px; border-top:1px solid var(--border); font-size:14px; color:var(--dim); }
  .cards { display:grid; grid-template-columns:1fr; gap:14px; margin:20px 0 40px; }
  .card { border:1px solid var(--border); border-radius:12px; padding:18px 20px; background:var(--surface); display:block; color:var(--text); }
  .card:hover { border-color:var(--accent); text-decoration:none; }
  .card b { display:block; margin-bottom:4px; }
  .card span { color:var(--dim); font-size:14px; }
  .cat { margin:36px 0 6px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  footer.site { border-top:1px solid var(--border); padding:24px; text-align:center; color:var(--dim); font-size:13px; }
  footer.site a { color:var(--dim); margin:0 8px; }
`;

function pageShell({ title, description, canonicalPath, mdPath, jsonLd, bodyHtml }) {
  const base = siteUrl();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${base}${canonicalPath}">
${mdPath ? `<link rel="alternate" type="text/markdown" title="Markdown version for LLMs" href="${base}${mdPath}">` : ""}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${base}${canonicalPath}">
<meta name="twitter:card" content="summary">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="site">
  <a class="brand" href="/">Waynode</a>
  <nav>
    <a href="/learn">Guides &amp; comparisons</a>
    <a href="/llms.txt">llms.txt</a>
    <a href="https://github.com/fornace/waynode">GitHub</a>
  </nav>
</header>
<main>${bodyHtml}</main>
<footer class="site">
  Waynode — open-source, self-hosted coding-agent workspaces.
  <div><a href="/">Home</a><a href="/learn">Learn</a><a href="/index.md">Home (markdown)</a><a href="/llms-full.txt">llms-full.txt</a></div>
</footer>
</body>
</html>`;
}

function articleJsonLd(a) {
  const base = siteUrl();
  const ld = [{
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title,
    description: a.description,
    datePublished: a.date,
    dateModified: a.updated,
    author: a.author
      ? { "@type": "Person", name: a.author, url: `${base}/learn` }
      : { "@type": "Organization", name: "Waynode", url: base },
    publisher: { "@type": "Organization", name: "Waynode", url: base },
    mainEntityOfPage: `${base}${a.path}`,
  }, {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Waynode", item: base },
      { "@type": "ListItem", position: 2, name: CATEGORIES[a.category].label, item: `${base}/learn` },
      { "@type": "ListItem", position: 3, name: a.title, item: `${base}${a.path}` },
    ],
  }];
  const faq = extractFaq(a.body);
  if (faq.length) {
    ld.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }
  return ld;
}

// --- routes -------------------------------------------------------------

// Every .md response opens with a discovery pointer so an agent landing on
// one page can find the whole corpus (the Resend pattern).
function mdWithPointer(md) {
  return `> Full index of Waynode's agent-readable content: ${siteUrl()}/llms.txt — fetch it to discover every page.\n\n${md}`;
}

// Content negotiation: a client that asks for text/markdown on an HTML page
// gets the markdown twin at the same URL.
router.use((req, res, next) => {
  const accept = req.headers.accept || "";
  if (!accept.includes("text/markdown")) return next();
  const p = req.path.replace(/\/$/, "");
  const negotiable = p === "" || p === "/learn" || Object.keys(CATEGORIES).some((c) => p.startsWith(`/${c}/`));
  if (negotiable && !p.endsWith(".md")) req.url = (p === "" ? "/index" : p) + ".md";
  next();
});

router.get("/learn", (req, res) => {
  const articles = allArticles();
  const sections = Object.entries(CATEGORIES).map(([key, cat]) => {
    const items = articles.filter((a) => a.category === key);
    if (!items.length) return "";
    return `<p class="cat">${cat.label}</p><div class="cards">${items.map((a) =>
      `<a class="card" href="${a.path}"><b>${esc(a.title)}</b><span>${esc(a.description)}</span></a>`).join("")}</div>`;
  }).join("");
  res.type("html").send(pageShell({
    title: "Waynode — Guides & Comparisons",
    description: "Guides and comparisons for self-hosted, persistent coding-agent workspaces: Waynode vs Codespaces, Devin, Cursor, and more.",
    canonicalPath: "/learn",
    mdPath: "/learn.md",
    jsonLd: null,
    bodyHtml: `<article><h1>Guides &amp; comparisons</h1><p>Everything about persistent, self-hosted coding-agent workspaces — and how Waynode compares to the rest of the ecosystem. Every page has a <a href="/llms.txt">markdown twin for LLMs</a>.</p>${sections}</article>`,
  }));
});

router.get("/learn.md", (req, res) => {
  const base = siteUrl();
  const articles = allArticles();
  const lines = ["# Waynode — Guides & Comparisons", ""];
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const items = articles.filter((a) => a.category === key);
    if (!items.length) continue;
    lines.push(`## ${cat.label}`, "");
    for (const a of items) lines.push(`- [${a.title}](${base}${a.path}.md): ${a.description}`);
    lines.push("");
  }
  res.type("text/markdown; charset=utf-8").send(lines.join("\n"));
});

for (const category of Object.keys(CATEGORIES)) {
  router.get(`/${category}/:slug.md`, (req, res, next) => {
    const a = findArticle(category, req.params.slug);
    if (!a) return next();
    res.type("text/markdown; charset=utf-8").send(mdWithPointer(a.raw));
  });
  router.get(`/${category}/:slug`, (req, res, next) => {
    const a = findArticle(category, req.params.slug);
    if (!a) return next();
    const byline = [a.author && `By ${esc(a.author)}`, a.updated && `Updated ${esc(a.updated)}`].filter(Boolean).join(" · ");
    const dateLine = byline ? `<p class="meta">${byline} · <a href="${a.path}.md">Markdown version</a></p>` : "";
    res.type("html").send(pageShell({
      title: `${a.title} — Waynode`,
      description: a.description,
      canonicalPath: a.path,
      mdPath: `${a.path}.md`,
      jsonLd: articleJsonLd(a),
      bodyHtml: `<div class="crumbs"><a href="/">Waynode</a> / <a href="/learn">${CATEGORIES[category].label}</a></div><article>${dateLine}${a.html}</article><p class="mdlink">Reading this with an AI assistant? Fetch the raw markdown at <a href="${a.path}.md">${a.path}.md</a> or the whole site at <a href="/llms-full.txt">/llms-full.txt</a>.</p>`,
    }));
  });
}

// --- agent-facing endpoints ----------------------------------------------

router.get("/index.md", (req, res, next) => {
  if (!existsSync(HOME_MD)) return next();
  res.type("text/markdown; charset=utf-8").send(mdWithPointer(readFileSync(HOME_MD, "utf8")));
});

router.get("/llms.txt", (req, res) => {
  const base = siteUrl();
  const articles = allArticles();
  const lines = [
    "# Waynode",
    "",
    "> Waynode is an open-source, self-hosted coding-agent workspace. Each workspace is a real cloned Git repository with a persistent worktree, terminal, and agent session you can open from desktop or mobile. Use it self-hosted (MIT, free) or as Waynode Cloud (managed hosting).",
    "",
    "Every HTML page on this site has a markdown twin: append `.md` to the URL.",
    "",
    `- [Waynode home (markdown)](${base}/index.md): What Waynode is, quick start, pricing`,
    `- [All guides & comparisons](${base}/learn.md): Index of every article`,
    "",
  ];
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const items = articles.filter((a) => a.category === key);
    if (!items.length) continue;
    lines.push(`## ${cat.label}`, "");
    for (const a of items) lines.push(`- [${a.title}](${base}${a.path}.md): ${a.description}`);
    lines.push("");
  }
  lines.push("## Optional", "", `- [Full content dump](${base}/llms-full.txt): Every article concatenated, for one-shot ingestion`);
  res.type("text/plain; charset=utf-8").send(lines.join("\n"));
});

router.get("/llms-full.txt", (req, res) => {
  const home = existsSync(HOME_MD) ? readFileSync(HOME_MD, "utf8") : "";
  const parts = [home, ...allArticles().map((a) => a.raw)];
  res.type("text/plain; charset=utf-8").send(parts.join("\n\n---\n\n"));
});

router.get("/robots.txt", (req, res) => {
  res.type("text/plain").send([
    "# AI crawlers and answer engines are welcome. Agent-readable index: /llms.txt",
    "User-agent: *",
    "Allow: /",
    "",
    "Content-Signal: ai-train=yes, search=yes, ai-input=yes",
    "",
    `Sitemap: ${siteUrl()}/sitemap.xml`,
  ].join("\n"));
});

router.get("/sitemap.xml", (req, res) => {
  const base = siteUrl();
  const urls = ["/", "/learn", ...allArticles().map((a) => a.path)];
  const body = urls.map((u) => `  <url><loc>${base}${u}</loc></url>`).join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`);
});

export default router;
