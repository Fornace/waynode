import { WaynodeMark } from "../components/Brand";

const PLANS = [
  { name: "Starter", price: "$39", purpose: "A small team sharing one build loop", specs: ["3 seats", "3M agent tokens / month", "10 GB storage"] },
  { name: "Pro", price: "$99", purpose: "More seats, tokens, and repository storage", specs: ["10 seats", "8M agent tokens / month", "50 GB storage"] },
  { name: "Team", price: "$249", purpose: "A larger shared pool for an engineering team", specs: ["25 seats", "20M agent tokens / month", "200 GB storage"] },
];

export function LandingPage() {
  return (
    <main className="product-page" id="top">
      <a className="skip-link" href="#product-content">Skip to main content</a>
      <header className="product-nav">
        <a className="product-brand" href="#top" aria-label="Waynode home"><WaynodeMark size={30} /><span>Waynode</span></a>
        <nav aria-label="Primary navigation">
          <a href="#continuity">How it works</a><a href="#deployment">Deployment</a><a href="#pricing">Pricing</a><a href="/learn">Guides</a>
          <a className="product-sign-in" href="/login">Sign in</a>
        </nav>
      </header>

      <section className="product-hero" id="product-content" tabIndex={-1}>
        <div>
          <p className="product-eyebrow">The durable worktree for agent work</p>
          <h1>Leave the laptop.<br /><em>Not the worktree.</em></h1>
          <p className="product-lede">Connect a repository, direct the agent, leave safely, then return to the same branch, conversation, and changed files from any device.</p>
          <div className="product-actions">
            <a className="product-primary" href="/login">Start 15-day hosted trial</a>
            <a className="product-secondary" href="https://github.com/Fornace/waynode/blob/main/docs/SELF-HOSTING.md">Self-host Waynode</a>
          </div>
          <p className="product-proof">Open source · GitHub and GitLab · Real cloned repositories</p>
        </div>
        <aside className="product-loop" aria-label="The Waynode worktree loop">
          <div className="product-loop-head"><WaynodeMark size={22} /><span>The worktree survives the handoff</span></div>
          <ol>
            <li><b>Connect</b><span>Clone the repository and branch on the server.</span></li>
            <li><b>Direct</b><span>Chat with the agent or assign a goal.</span></li>
            <li><b>Return</b><span>Resume the same session from web or native clients.</span></li>
            <li><b>Review</b><span>Inspect changed files before commit and push.</span></li>
          </ol>
        </aside>
      </section>

      <section className="product-section" id="continuity">
        <div className="product-section-copy"><p className="product-eyebrow">Continuity</p><h2>One repository. One branch. No context reconstruction.</h2><p>Waynode keeps the agent beside the real Git worktree instead of reducing a coding session to a disposable remote task.</p></div>
        <div className="product-steps">
          <article><span>01</span><h3>Start at your desk</h3><p>Choose the repository and branch, then give the agent a concrete outcome.</p></article>
          <article><span>02</span><h3>Leave without stopping</h3><p>The server keeps the session and worktree together while your client is closed.</p></article>
          <article><span>03</span><h3>Return to evidence</h3><p>Open the same session, inspect the current run state, and review exactly what changed.</p></article>
        </div>
      </section>

      <section className="product-review">
        <div><p className="product-eyebrow">Review</p><h2>The worktree is the product.</h2><p>“Done” is not a reassuring chat message. It is an inspectable branch with changed files, a diff, and a safe next action.</p></div>
        <dl>
          <div><dt>Repository + branch</dt><dd>Identity stays visible while the agent works.</dd></div>
          <div><dt>Changed files + diff</dt><dd>Review the evidence beside the conversation.</dd></div>
          <div><dt>Commit + push</dt><dd>Git mutations happen after review, in the same worktree.</dd></div>
        </dl>
      </section>

      <section className="product-section" id="deployment">
        <div className="product-section-copy"><p className="product-eyebrow">Deployment</p><h2>Managed when you want it. Owned when you need it.</h2><p>Cloud and self-hosted use the same open-source product, with deliberately different operational boundaries.</p></div>
        <div className="product-deployments">
          <article><h3>Waynode Cloud</h3><p>We operate the server, updates, encrypted secrets, and Stripe billing. You connect repositories and use isolated agent chat, goals, Git review, commit, and push.</p><ul><li>15-day organization trial</li><li>Web and native clients</li><li>Hardware-isolated agent runs</li></ul><a href="/login">Start hosted trial</a></article>
          <article><h3>Self-hosted</h3><p>Run the MIT-licensed stack on infrastructure you control, with your own network, model credentials, storage, and operating policy.</p><ul><li>No hosted Stripe requirement</li><li>GitHub and GitLab OAuth</li><li>Interactive workspace terminal</li></ul><a href="https://github.com/Fornace/waynode/blob/main/docs/SELF-HOSTING.md">Read the install guide</a></article>
        </div>
      </section>

      <section className="product-section product-pricing" id="pricing">
        <div className="product-section-copy"><p className="product-eyebrow">Hosted pricing</p><h2>Pay for a shared worktree, not a vague promise.</h2><p>The trial is 15 days with one seat, 5M agent tokens, and 2 GB storage. Paid quotas are organization-wide monthly pools.</p></div>
        <div className="product-plans">{PLANS.map((plan) => <article key={plan.name}><h3>{plan.name}</h3><p>{plan.purpose}</p><div><b>{plan.price}</b><span>/ month</span></div><ul>{plan.specs.map((spec) => <li key={spec}>{spec}</li>)}</ul><a href="/login">Start trial</a></article>)}</div>
      </section>

      <footer className="product-footer">
        <a className="product-brand" href="#top"><WaynodeMark size={25} /><span>Waynode</span></a>
        <span>Open-source durable worktrees for coding agents.</span>
        <nav aria-label="Footer"><a href="https://github.com/Fornace/waynode">GitHub</a><a href="/learn">Guides</a><a href="/llms.txt">llms.txt</a><a href="/index.md">Markdown</a><a href="/login">Sign in</a></nav>
      </footer>
    </main>
  );
}
