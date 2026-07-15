/** Paid-launch public trust surface regression contract. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const router = read("frontend/src/AppRouter.tsx");
const landing = read("frontend/src/pages/LandingPage.tsx");
const privacy = read("frontend/src/pages/PrivacyPolicyContent.tsx");
const terms = read("frontend/src/pages/TermsContent.tsx");
const support = read("frontend/src/pages/TrustSupportContent.tsx");
const page = read("frontend/src/pages/PublicTrustPage.tsx");
const css = read("frontend/src/styles/public-trust.css");
const server = read("server.js");
const health = read("lib/health.mjs");
const content = read("routes/content.js");
const launchGate = read("docs/HOSTED-LAUNCH.md");

const paths = ["privacy", "terms", "security", "support", "status"];
for (const path of paths) {
  assert.ok(router.includes(`path="/${path}"`), `missing public route /${path}`);
  assert.ok(landing.includes(`href="/${path}"`), `landing footer missing /${path}`);
  assert.ok(content.includes(`href="/${path}"`), `content footer missing /${path}`);
  assert.ok(content.includes(`"/${path}"`), `sitemap source missing /${path}`);
}

for (const fact of [
  "GitHub or GitLab account ID", "OAuth access or refresh token", "cloned source",
  "prompts, model responses", "Stripe customer/subscription identifiers",
  "infrastructure errors", "backup rotation to 14 days", "self-hosted Waynode",
]) assert.ok(privacy.includes(fact), `privacy notice missing: ${fact}`);
assert.match(privacy, /EU General Data Protection Regulation/);
assert.match(privacy, /info@fornacestudio\.com/);

for (const fact of [
  "15 days", "exact price, currency, taxes", "Subscriptions renew",
  "Cancellation stops future renewal", "14 days from conclusion",
  "does not automatically remove the right", "proportionate amount", "Statutory refunds",
]) assert.ok(terms.includes(fact), `terms missing: ${fact}`);
assert.match(terms, /europa\.eu\/youreurope/);
assert.match(terms, /consumer-information-right-of-withdrawal/);

assert.match(support, /hardware-isolated sandbox/);
assert.match(support, /not a certification, penetration-test report, security warranty, or SLA/);
assert.match(support, /no guaranteed initial-response or/);
assert.match(page, /fetch\("\/api\/health\/ready"/);
assert.match(page, /does not expose dependency names/);
assert.match(page, /Fornace · Italy/);

assert.match(server, /publicReadinessReport\(report\)/);
assert.match(health, /return \{ ready: report\.ready === true \}/);
assert.doesNotMatch(health.split("publicReadinessReport")[1], /checks|revision|deployment/);
assert.match(css, /@media \(max-width: 760px\)/);
assert.match(css, /@media \(max-width: 520px\)/);

assert.match(launchGate, /blocks charging customers/);
assert.match(launchGate, /registered legal operator identity/);
assert.match(launchGate, /VAT\/tax registration details/);
assert.match(launchGate, /counsel review/);

const combined = [privacy, terms, support, page].join("\n");
for (const inventedClaim of ["99.9%", "SOC 2 certified", "ISO 27001 certified", "registered office", "VAT number:"]) {
  assert.ok(!combined.includes(inventedClaim), `invented public claim: ${inventedClaim}`);
}

for (const path of [
  "frontend/src/AppRouter.tsx", "frontend/src/pages/PrivacyPolicyContent.tsx",
  "frontend/src/pages/TermsContent.tsx", "frontend/src/pages/TrustSupportContent.tsx",
  "frontend/src/pages/PublicTrustPage.tsx", "frontend/src/styles/public-trust.css",
]) {
  const lines = read(path).split("\n").length;
  assert.ok(lines <= 400, `${path} has ${lines} lines`);
}

console.log("public trust: routes, factual policy coverage, sanitized status, footer, and legal gate passed");
