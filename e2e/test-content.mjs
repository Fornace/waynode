/** Content hub regression test: articles, markdown twins, llms.txt, negotiation. */
import assert from "node:assert/strict";
import express from "express";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "content-test";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { default: contentRoutes } = await import("../routes/content.js");

const app = express();
app.use(contentRoutes);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
const root = new URL("../", import.meta.url);

// Explanatory-frames contract (flagship doctrine): the landing teaches with
// pure CSS/SVG frames — no raster captures, no hotlinked images.
const landingSource = readFileSync(new URL("frontend/src/pages/LandingPage.tsx", root), "utf8");
for (const raster of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
  assert.ok(!landingSource.includes(raster), `landing references raster image: ${raster}`);
}
assert.ok(!landingSource.includes('src="http'), "landing must not hotlink images");

for (const frame of ["frame-tri-selector", "frame-verified-run", "frame-handoff"]) {
  assert.ok(landingSource.includes(frame), `landing missing explanatory frame: ${frame}`);
}
for (const href of ["/privacy", "/terms", "/security", "/support", "/status"]) {
  assert.ok(landingSource.includes(`href="${href}"`), `landing footer missing ${href}`);
}

const marketingDir = new URL("frontend/public/marketing/", root);
if (existsSync(marketingDir)) {
  const totalBytes = readdirSync(marketingDir, { recursive: true })
    .reduce((sum, name) => {
      const file = new URL(name, marketingDir);
      return statSync(file).isFile() ? sum + statSync(file).size : sum;
    }, 0);
  assert.ok(totalBytes < 200_000, `public marketing assets exceed budget: ${totalBytes} bytes`);
}

assert.ok(!landingSource.includes("product-pricing"), "public plan cards must stay out of the landing page");
assert.ok(!landingSource.includes("Most popular"), "landing must not invent a preferred hosted plan");

async function get(path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
}

try {
  const llms = await get("/llms.txt");
  assert.equal(llms.status, 200);
  assert.match(llms.body, /^# Waynode/);
  assert.match(llms.body, /llms-full\.txt/);

  const home = await get("/index.md");
  assert.equal(home.status, 200);
  assert.match(home.type, /text\/markdown/);
  assert.match(home.body, /llms\.txt/); // discovery pointer

  const learn = await get("/learn");
  assert.equal(learn.status, 200);
  assert.match(learn.type, /text\/html/);

  const robots = await get("/robots.txt");
  assert.match(robots.body, /Allow: \//);
  assert.match(robots.body, /Content-Signal/);

  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.body, /<urlset/);

  // Per-article checks run against whatever is published in content/articles.
  const learnMd = await get("/learn.md");
  const articlePaths = [...learnMd.body.matchAll(/\((https?:[^)]+\.md)\)/g)].map((m) => new URL(m[1]).pathname);
  let checked = 0;
  for (const mdPath of articlePaths.slice(0, 3)) {
    const md = await get(mdPath);
    assert.equal(md.status, 200, mdPath);
    assert.match(md.type, /text\/markdown/, mdPath);
    const htmlPath = mdPath.replace(/\.md$/, "");
    const html = await get(htmlPath);
    assert.equal(html.status, 200, htmlPath);
    assert.match(html.body, /application\/ld\+json/, htmlPath);
    // Content negotiation: markdown at the HTML URL
    const negotiated = await get(htmlPath, { accept: "text/markdown" });
    assert.match(negotiated.type, /text\/markdown/, `${htmlPath} negotiation`);
    checked++;
  }

  console.log(`content hub: explanatory frames verified (no raster, budget ok), core endpoints ok, ${checked} article(s) round-tripped`);
} finally {
  server.close();
}
