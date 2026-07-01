# Waynode Hosted Pricing

This document is the pricing design for **waynode.fornace.net** (the hosted
product). It does not apply to self-hosted installs — self-hosters run their
own LLM keys and pay Anthropic/whoever-they-choose directly; nothing in the
Docker image requires Stripe or these tiers.

All numbers below are a starting proposal for human review. They are not
final — this file exists so the reasoning is legible, not just a table.

## 1. Cost basis

The product owner said fornace model costs are "roughly Qwen3.7 Max." Verified
pricing (Alibaba Cloud Model Studio / DashScope, international/Singapore
endpoint, checked 2026-07-01):

| | Input $/M tokens | Output $/M tokens |
|---|---|---|
| Standard / list price | **$2.50** | **$7.50** |
| Promotional (int'l, ends 23:59 UTC+8 Jul 22 2026) | $1.25 | $3.75 |

Sources: https://www.alibabacloud.com/help/en/model-studio/model-pricing,
https://www.alibabacloud.com/campaign/qwen-discount

**We use the standard/list rate ($2.50 / $7.50), not the promo rate**, for all
margin math below. The promo expires in three weeks (per its own terms) and a
margin model built on a rate that disappears before the first invoice cycle
completes is not a margin model — it's a mistake waiting to surface as a
finance surprise.

Note the DashScope page also lists a cheaper China-region (Beijing) rate
($1.65/$4.95) — not used here, since a hosted product serving international
customers would run the international/Singapore endpoint fornace actually
uses.

### Input:output ratio for a coding-agent workload

Coding agents send large amounts of file/repo context as input relative to
what they generate as output, and "thinking"/reasoning tokens (billed as
output) add further weight to the output side. The most rigorous public data
point found — an instrumented study of an agentic coding framework across 30
tasks (arxiv.org/html/2601.14470v1, "Tokenomics: Quantifying Where Tokens Are
Used in Agentic Software Engineering") — measured a blended composition of
**53.9% input / 24.4% output / 21.6% reasoning**, i.e. roughly 54% input /
46% output+reasoning when reasoning is counted with output. That varies a lot
by phase (raw code-generation turns are output-heavy; code review and
documentation phases are strongly input-heavy from repeated context
re-consumption).

No coding-agent vendor (Cursor, Cline, Aider, Copilot, Windsurf) publishes
their actual input:output split.

**We use 70/30 (input-heavy)** as a deliberately conservative-toward-input
assumption for margin purposes — it sits above what the one rigorously
measured dataset found (54/46), which is the right direction to err when the
number feeds a margin floor: overestimating the cheaper token type (input)
relative to blended cost would understate COGS, so leaning input-heavy here
is the safe error, not the risky one. Treat this as a working assumption to
replace with real telemetry once the fornace gateway/pi surfaces actual usage
data (see §4).

**Blended worst-case cost:**

```
0.70 × $2.50/M (input)  = $1.75
0.30 × $7.50/M (output) = $2.25
                          ------
Blended cost per 1M tokens = $4.00  (standard rate, 70/30 split)
```

This $4.00/M blended figure is the COGS input to every margin calculation
below. It is deliberately the *worst case* — a customer who is 100% "thinking
tokens" or 100% output-heavy tool-call spam would cost more; one who is
mostly cached/short prompts would cost less. Pricing to worst case is the
right call per the brief: heavy/abusive usage inside a quota is the actual
margin risk, not the average customer.

## 2. Free tier (given, not designed)

- 2 GB storage
- 5,000,000 tokens/month, combined across fornace reasoning/max/fast,
  including thinking tokens
- 1 seat (implicit — no paid multi-seat features)

Worst-case COGS for Free: `5M / 1M × $4.00 = $20.00/month` per fully-utilized
free org. This is a real, accepted customer-acquisition cost, not something
this doc tries to eliminate — it's bounded hard by the quota (see §5 on
enforcement gaps) and is standard for a "try it free" LLM-wrapper product.

## 3. Paid tiers

Naming follows the README's plain, unpretentious voice ("Open-source,
self-hosted coding-agent workspace... Mobile-first. Small-team ready.") —
Starter / Pro / Team, no cute names.

| | **Starter** | **Pro** | **Team** |
|---|---|---|---|
| Price | **$39/mo** | **$99/mo** | **$249/mo** |
| Storage | 10 GB | 50 GB | 200 GB |
| Tokens/mo | 3,000,000 | 8,000,000 | 20,000,000 |
| Seats | 3 | 10 | 25 |
| Differentiators | — | Priority session queueing¹ | Priority queueing¹ + concurrent session cap raised² |

¹ **Priority queueing** — technically feasible today: `lib/agent-manager.mjs`
already manages one agent process per session with an internal event
broadcast/queue model; a priority flag on session creation that jumps a paid
org's session ahead of free-tier sessions when the fornace LLM gateway is
under load is a small, real addition, not vaporware. Not yet built — flagged
as a "sell it, then build the actual priority-lane wiring in the gateway"
item, see §6.

² **Concurrent session cap** — the codebase has no explicit cap on concurrent
pi sessions per org today (worth confirming there isn't an implicit one from
process/resource limits before shipping this as a differentiator), so "Team
gets N concurrent, Starter/Pro get fewer" is a policy this app would need to
add, not something that exists. Listed as directionally buildable, not
currently enforced.

### Margin math (worst case: 100% token quota utilized, at standard/list rate)

```
Starter: $39 - (3M/1M × $4.00)  = $39 - $12.00  = $27.00 margin  → 69.2%
Pro:     $99 - (8M/1M × $4.00)  = $99 - $32.00  = $67.00 margin  → 67.7%
Team:   $249 - (20M/1M × $4.00) = $249 - $80.00 = $169.00 margin → 67.9%
```

All three tiers clear ~68% gross margin even if every customer burns their
entire token quota every month on the most expensive possible token mix. This
is on the conservative side of the 70-80% SaaS norm, not comfortably inside
it — see the honest caveat below.

### The real tension: token quota vs. Free tier, and why it's this small

An early draft of this table gave Starter meaningfully more tokens than the
5M Free tier (8-30M) at $19-59/mo. **The margin math killed every version of
that.** At $4.00/M blended COGS, a quota of `price × ~0.47M tokens` is
roughly the ceiling for a 75% margin at full utilization; anything above that
line either erodes margin below the 70% floor or the price has to jump into
the $100-600/mo range to compensate (see the worked alternatives in the git
history of this doc / the agent's calculation log if you want to see the
sweep). That is the actual shape of margins for an LLM-wrapper SaaS at this
underlying model cost — it is why every serious LLM app (Cursor, Copilot,
etc.) either caps included tokens tightly and monetizes seats/features, or
sells token overage separately instead of a large flat allowance.

**Given that, Starter's 3M/mo is *less* than Free's 5M/mo.** This looks odd
at first glance but is a deliberate, common SaaS pattern once you separate
what each tier is actually selling:

- **Free** is a single-seat trial with a generous token allowance to let one
  person fully evaluate the product — acceptable to subsidize once, per
  signup, because it's capped and non-recurring-revenue-bearing.
- **Starter/Pro/Team** are *team* products. The value is seats (3/10/25),
  storage (10/50/200 GB), and roadmap differentiators (priority queueing,
  concurrency), not "more tokens than a single free trial." A 3-person team
  on Starter effectively gets 1M tokens/seat/month — more relevant framing
  than comparing the org-wide pool to Free's single-seat pool.
- If this reads as a bad trade to real customers in practice (a paying team
  hitting the token wall faster than they'd like), the correct lever is
  **usage-based overage billion for tokens above the quota** (e.g. metered at
  cost-plus-margin, $X per additional 1M tokens) rather than inflating the
  included allowance and eating the margin. That's a Stripe metered-billing
  feature this scaffolding does not yet implement (see §6) — flagging it here
  because it's the honest answer to "then how do heavy users get more
  tokens without breaking the model."

**Recommendation for the human reviewer:** treat the $39/$99/$249 price
points and 3M/8M/20M quotas as the systematically-derived floor, not a
confident final answer — they are legibly *derived* from the cost model
above, but the actual willingness-to-pay for a coding-agent workspace product
is a market question this doc cannot answer. If real signups show tolerance
for higher prices, raising them is pure margin upside with zero cost-model
risk (the COGS is fixed; only the price is a guess). If $39 is too high for a
"Starter" self-serve tier, the fix is add overage billing, not raise the
included quota at fixed price.

## 4. Token usage metering — what's real vs. stubbed

**RPC path (`AgentHandle`, non-sandboxed — the default today): wired and
verified against a real chat turn.** pi's RPC protocol exposes a
`get_session_stats` command (`{type:"get_session_stats"}` →
`{type:"response", command:"get_session_stats", success:true, data:
SessionStats}`) that returns `tokens.total`, a *cumulative* count for the
whole pi session. `AgentHandle._onAgentEnd()` (`lib/agent-manager.mjs`) calls
`_meterTokenUsage()` after every turn: it sends `get_session_stats`, diffs
`tokens.total` against `this._lastTokenTotal` (tracked per-handle, init 0),
and calls `recordTokenUsage(space.org_id, delta)` for the positive delta only
— diffing against cumulative, not billing the raw total, is required or every
turn would re-bill the entire conversation's tokens so far. If the space has
no `org_id` (self-host / personal space), metering is skipped, not thrown.
Confirmed live: two real chat turns against `fornace/fornace-fast` through
the actual HTTP → `AgentHandle.sendPrompt` path incremented
`org_usage.tokens_used` from 0 → 34,843 → 69,698 (a second delta of ~34,855,
not a re-billed cumulative total).

**Sandboxed path (`SandboxedAgentHandle` — one-shot microVM per turn, used
when `/dev/kvm` is available): wired via a different mechanism, unverified
live (no KVM in this dev environment).** There's no long-lived RPC session to
query `get_session_stats` on — each turn spawns a fresh `pi` process and
exits. Instead, `lib/pi-runner.mjs`'s `computeSessionTokenTotal(sessionDir)`
reads the persisted session JSONL directly (host-readable: `pi_session_dir`
lives inside the bind-mounted repo, not inside the microVM) and sums
`usage.{input,output,cacheRead,cacheWrite}` off every assistant message — the
exact same computation pi's own `getSessionStats()` does internally, just
performed from the host against the file instead of in-process. This was
verified against a real RPC session's `.jsonl` output (usage fields present
and summed correctly) but not against an actual `runInSandbox()` execution,
since `isSandboxAvailable()` is always false without `/dev/kvm`.
`SandboxedAgentHandle._meterTokenUsage()` calls this after every
`sendPrompt()`, with the same delta-tracking and no-org-id-skip logic as the
RPC path.

## 5. Storage metering — what's real vs. approximate

`routes/billing.js`'s `measureOrgStorageBytes()` shells out to `du -sk` on
each space's `local_path` and sums the result. This is a real, working
measurement (not stubbed), refreshed on every `GET
/api/orgs/:orgId/billing` call and persisted to `org_usage.storage_bytes`.
Caveats: `du` on a large repo tree is not free (I/O cost scales with repo
size/count), it doesn't account for shared/hardlinked blobs across spaces,
and there is no continuous/scheduled recalculation — it is a point-in-time
snapshot taken when someone loads the Billing tab, not enforced against the
quota at write time (a space clone is never blocked for being over quota).

## 6. What still needs a human / isn't built

- Create the actual Stripe account + 3 recurring monthly Prices for
  Starter/Pro/Team, and a webhook endpoint pointed at
  `https://waynode.fornace.net/api/billing/webhook`.
- Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_STARTER/PRO/TEAM` in the hosted deployment's env — never in
  the self-host `.env.example` as anything but blank.
- Decide on a real token-usage data source (§4) — this is required before
  quota enforcement (blocking usage over quota) can exist; today
  `checkQuota()` reports `exceeded: true/false` but nothing acts on it.
- Decide whether/when to add Stripe metered billing for token overage (§3).
- Priority queueing and concurrency-cap differentiators (§3 footnotes) are
  sold in the tier table but not implemented in `lib/agent-manager.mjs` —
  build before or shortly after launch, or drop them from the tier copy.
- Re-verify pricing before launch: the Qwen3.7 Max promo rate expires
  2026-07-22 and DashScope's own page was last updated 2026-06-26 — reconfirm
  the standard rate hasn't also changed by the time Stripe products are
  actually created.
