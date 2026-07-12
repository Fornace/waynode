import { WaynodeMark } from "../components/Brand";
import { LoginPage } from "./LoginPage";

const PLANS = [
  { name: "Starter", price: "$39", detail: "For a focused build loop", specs: ["3 seats", "3M agent tokens / month", "10 GB workspace storage"] },
  { name: "Pro", price: "$99", detail: "For the team that ships daily", specs: ["10 seats", "8M agent tokens / month", "50 GB workspace storage"], featured: true },
  { name: "Team", price: "$249", detail: "For a whole engineering team", specs: ["25 seats", "20M agent tokens / month", "200 GB workspace storage"] },
];

const COMPARISON = [
  ["A coding chat", "A persistent repo workspace"],
  ["A remote task", "A live worktree you can enter"],
  ["A change you discover later", "Diff, commit, and push in one place"],
];

export function LandingPage() {
  return (
    <main className="launch-page">
      <header className="launch-nav">
        <a className="launch-brand" href="#top" aria-label="Waynode home"><WaynodeMark size={30} /><span>Waynode</span></a>
        <nav aria-label="Primary navigation"><a href="#how-it-works">How it works</a><a href="#compare">Why Waynode</a><a href="#pricing">Pricing</a><a href="/learn">Learn</a><a className="launch-nav-github" href="https://github.com/fornace/waynode" target="_blank" rel="noreferrer">View on GitHub <span>↗</span></a></nav>
      </header>

      <section className="launch-hero" id="top">
        <div className="launch-hero-copy">
          <div className="launch-kicker"><i /> Your codebase, ready wherever you are</div>
          <h1>Leave the laptop.<br /><em>Not the worktree.</em></h1>
          <p>Waynode gives coding work a real, persistent Git workspace. Start a task at your desk, inspect the diff on your phone, and finish it from any device—with the repository, terminal, and conversation still there.</p>
          <div className="launch-actions"><a className="launch-primary" href="#auth">Start free for 15 days <span>→</span></a><a className="launch-secondary" href="#how-it-works">See the workspace <span>↓</span></a></div>
          <div className="launch-hero-proof"><span><b>✓</b> Real cloned repositories</span><span><b>✓</b> GitHub &amp; GitLab</span><span><b>✓</b> Open source</span></div>
        </div>
        <div className="launch-hero-stage" aria-label="Waynode workspace mockup">
          <div className="launch-aurora launch-aurora-one" /><div className="launch-aurora launch-aurora-two" />
          <DesktopWorkspace />
          <div className="launch-device-chip launch-device-chip-top"><span className="launch-dot" /> Synced worktree <b>api-server</b></div>
          <div className="launch-device-chip launch-device-chip-bottom"><span>⌘</span><div><b>7 files changed</b><small>Ready to review</small></div></div>
        </div>
      </section>

      <section className="launch-marquee" aria-label="Waynode principles"><span>Persistent worktrees</span><i>✦</i><span>Agent-native Git</span><i>✦</i><span>Desktop to mobile</span><i>✦</i><span>Your infrastructure</span><i>✦</i><span>Persistent worktrees</span></section>

      <section className="launch-continuity" id="how-it-works">
        <div className="launch-section-heading"><p className="launch-kicker">A repo is more than a task</p><h2>One living workspace.<br />Every screen you own.</h2><p>Most agent products hand work to a remote run or a local chat. Waynode keeps the actual repository at the center: files, branches, terminal state, sessions, and review history.</p></div>
        <div className="launch-continuity-grid">
          <article className="launch-continuity-copy"><span className="launch-number">01</span><h3>Connect it once</h3><p>Clone a GitHub or GitLab repository into a dedicated space. Your agent gets a real directory, not a disposable attachment.</p><div className="launch-mini-repo"><span className="launch-git-icon">⌘</span><div><b>waynode / api-server</b><small>main · clean · last synced now</small></div><span className="launch-mini-status">●</span></div></article>
          <article className="launch-continuity-copy"><span className="launch-number">02</span><h3>Let the agent work</h3><p>Use chat for a focused request, send an autonomous goal, or open the full terminal when you want the controls.</p><div className="launch-mini-terminal"><span>$</span> pi <i>"add OAuth callback diagnostics"</i><br /><b>›</b> Inspecting authentication flow…</div></article>
          <article className="launch-continuity-copy"><span className="launch-number">03</span><h3>Pick up anywhere</h3><p>The conversation and worktree are waiting when you come back. Review the diff, commit, and push without reconstructing context.</p><div className="launch-mini-commit"><span>↗</span><div><b>Ready to commit</b><small>7 changed files · 1 branch ahead</small></div><button type="button">Review</button></div></article>
        </div>
      </section>

      <section className="launch-worktree-showcase">
        <div className="launch-worktree-copy"><p className="launch-kicker">The worktree is the product</p><h2>See the agent’s work<br />before it leaves the repo.</h2><p>Every space has an inspectable Git surface. Changed files, hunks, commits, and push all live beside the conversation—so “done” means ready for review, not merely finished running.</p><a className="launch-text-link" href="#auth">Bring a repository to Waynode <span>→</span></a></div>
        <GitWorktree />
      </section>

      <section className="launch-mobile-section">
        <div className="launch-mobile-copy"><p className="launch-kicker">Not a desktop product squeezed smaller</p><h2>Your agent’s work,<br /><em>in your pocket.</em></h2><p>Open the same workspace on mobile to check progress, read a diff, steer the agent, or push a reviewed change. The heavy work stays in the workspace; you stay in the loop.</p><div className="launch-mobile-points"><span><b>01</b> Follow a live task</span><span><b>02</b> Review changed files</span><span><b>03</b> Send the next instruction</span></div></div>
        <div className="launch-phone-stage"><div className="launch-phone-glow" /><MobileWorkspace /><div className="launch-mobile-label">Same repo <i>·</i> Same session <i>·</i> Any device</div></div>
      </section>

      <section className="launch-compare" id="compare">
        <div className="launch-compare-intro"><p className="launch-kicker">Why a workspace, not another agent tab?</p><h2>Cloud agents are useful.<br />Waynode makes the workspace <em>yours.</em></h2><p>Claude Code, Codex, Codespaces, Cursor, and similar tools each solve valuable parts of the loop. Waynode is for the gap between them: a durable place where its built-in agent works in your repository and you can return from any device.</p></div>
        <div className="launch-compare-table"><div className="launch-compare-head"><span>What breaks momentum</span><span>What Waynode keeps intact</span></div>{COMPARISON.map(([other, ours]) => <div className="launch-compare-row" key={other}><span><i>−</i>{other}</span><span><i>+</i>{ours}</span></div>)}<div className="launch-compare-foot">Use Waynode hosted for speed, or self-host it where your code needs to stay.</div></div>
      </section>

      <section className="launch-choice"><div className="launch-choice-card launch-choice-cloud"><p className="launch-kicker">Waynode Cloud</p><h3>Get a persistent workspace in minutes.</h3><p>We run the workspace, encrypted secrets, updates, and billing. You bring the repositories and the work.</p><a className="launch-text-link" href="#auth">Start a 15-day trial <span>→</span></a></div><div className="launch-choice-card"><p className="launch-kicker">Self-hosted</p><h3>Keep the whole control plane close.</h3><p>Run the open-source stack in your own environment with your own network controls, models, and credentials.</p><a className="launch-text-link" href="https://github.com/fornace/waynode#readme" target="_blank" rel="noreferrer">Read the install guide <span>↗</span></a></div></section>

      <section className="launch-pricing" id="pricing"><div className="launch-section-heading"><p className="launch-kicker">Simple hosted pricing</p><h2>A room for every build team.</h2><p>Every hosted plan starts with 15 free days. Upgrade only when Waynode earns a permanent place in your workflow.</p></div><div className="launch-pricing-grid">{PLANS.map((plan) => <article className={`launch-price-card ${plan.featured ? "is-featured" : ""}`} key={plan.name}>{plan.featured && <div className="launch-popular">Most popular</div>}<h3>{plan.name}</h3><p>{plan.detail}</p><div className="launch-price"><b>{plan.price}</b><span>/ month</span></div><ul>{plan.specs.map((spec) => <li key={spec}>✓ {spec}</li>)}</ul><a className={plan.featured ? "launch-primary" : "launch-secondary"} href="#auth">Start free trial <span>→</span></a></article>)}</div><p className="launch-pricing-note">Web checkout is powered by Stripe. Mobile subscriptions are available through the App Store where supported.</p></section>

      <section className="launch-auth" id="auth"><div><p className="launch-kicker">Your next repo is ready</p><h2>Stop carrying<br />your workspace around.</h2><p>Sign in to start your hosted trial. Prefer full infrastructure control? Waynode is MIT licensed and ready to self-host.</p></div><LoginPage /></section>
      <footer className="launch-footer"><a className="launch-brand" href="#top"><WaynodeMark size={25} /><span>Waynode</span></a><span>Open source, persistent agent workspaces.</span><div><a href="https://github.com/fornace/waynode" target="_blank" rel="noreferrer">GitHub</a><a href="https://github.com/fornace/waynode#readme" target="_blank" rel="noreferrer">Docs</a><a href="/learn">Guides &amp; comparisons</a><a href="/llms.txt" title="Agent-readable index of this site">llms.txt</a><a href="/index.md" title="This page as markdown, for AI assistants">Read as markdown</a></div></footer>
    </main>
  );
}

function DesktopWorkspace() { return <div className="mock-desktop"><div className="mock-topbar"><span className="mock-traffic"><i /><i /><i /></span><b>waynode</b><span>api-server <em>/</em> OAuth callback</span><div className="mock-top-actions"><span>Fornace Fast⌄</span><b>Git</b><b>Chat</b></div></div><div className="mock-desktop-body"><aside className="mock-sidebar"><div className="mock-workspace"><WaynodeMark size={16} /><b>Francesco’s Workspace</b></div><button type="button">＋ Clone repository</button><p>SPACES</p><div className="mock-space active"><span>⌄</span><b>api-server</b><i>7</i></div><div className="mock-session active">OAuth diagnostics</div><div className="mock-session">Add audit events</div><div className="mock-session">Refine callback flow</div><div className="mock-space"><span>›</span><b>dashboard</b></div><div className="mock-space"><span>›</span><b>waynode</b></div></aside><section className="mock-chat"><div className="mock-chat-head"><div><b>OAuth callback</b><small>api-server · main</small></div><span className="mock-live"><i /> Agent working</span></div><div className="mock-message mock-user">The Mac app crashes after GitHub login. Find the cause, fix it, and leave a clean diff.</div><div className="mock-agent"><div className="mock-agent-title"><WaynodeMark size={17} /> Waynode agent <span>just now</span></div><p>I traced the callback onto Safari’s XPC queue. I’m moving presentation safely to the main actor and adding correlated push diagnostics.</p><div className="mock-tool"><span>⌘</span><div><b>Investigating AuthView.swift</b><small>Read 3 files · found 1 unsafe presentation path</small></div><i>✓</i></div><div className="mock-tool"><span>⌁</span><div><b>Running Mac Catalyst build</b><small>Building…</small></div><i className="is-running" /></div></div><div className="mock-composer">Message the agent… <b>↗</b></div></section></div></div>; }

function GitWorktree() { return <div className="mock-git"><div className="mock-git-head"><div><span className="mock-git-badge">⌘</span><b>Git worktree</b><small>api-server · main</small></div><span className="mock-ahead">↑ 1 commit ahead</span></div><div className="mock-git-tabs"><b>Changes <i>7</i></b><span>Commits</span><span>Branches</span></div><div className="mock-git-main"><aside><p>CHANGED FILES</p>{[["AuthView.swift", "+18 −4"], ["APIClient.swift", "+12 −2"], ["GitInspector.swift", "+11"], ["SessionStore.swift", "+3 −6"], ["Waynode.entitlements", "+1"]].map(([file, stat], n) => <div className={n === 0 ? "selected" : ""} key={file}><i>{n === 0 ? "M" : "M"}</i><span>{file}</span><small>{stat}</small></div>)}</aside><section><div className="mock-file-head"><b>AuthView.swift</b><span>Unified diff</span></div><pre><code><i>  294</i> <span className="diff-context">func presentationAnchor(for session: …)</span>{"\n"}<i>  295</i> <span className="diff-add">+ let scenes = UIApplication.shared.connectedScenes</span>{"\n"}<i>  296</i> <span className="diff-add">{`+   .compactMap { $0 as? UIWindowScene }`}</span>{"\n"}<i>  297</i> <span className="diff-del">- preconditionFailure(&quot;Requires active scene&quot;)</span>{"\n"}<i>  298</i> <span className="diff-add">+ return scene.windows.first ?? ASPresentationAnchor()</span>{"\n"}<i>  299</i> <span className="diff-context">{"}"}</span></code></pre></section></div><div className="mock-commit-bar"><div><span>Commit message</span><b>Harden OAuth presentation</b></div><button type="button">Commit &amp; push <span>→</span></button></div></div>; }

function MobileWorkspace() { return <div className="mock-phone"><div className="mock-phone-screen"><div className="mock-phone-notch" /><header><span>9:41</span><span>● ● ● ▰</span></header><div className="mock-mobile-nav"><button type="button">‹</button><div><b>api-server</b><small>OAuth callback</small></div><button type="button">⋯</button></div><div className="mock-mobile-branch"><span>⌘</span><b>main</b><small>7 changed</small><i>● Synced</i></div><div className="mock-mobile-tabs"><b>Chat</b><span>Git <i>7</i></span><span>Terminal</span></div><div className="mock-mobile-message user">Can you make this safe on Mac Catalyst too?</div><div className="mock-mobile-message agent"><div><WaynodeMark size={15} /><b>Waynode</b><small>now</small></div><p>Yes. The workspace has the same branch and diff from your desktop. I’ve made the callback fallback safe and the build is green.</p><div className="mock-mobile-diff"><span>⌘</span><div><b>7 files ready to review</b><small>Tap to inspect changes</small></div><i>›</i></div></div><div className="mock-mobile-composer">Message agent <b>↑</b></div></div></div>; }
