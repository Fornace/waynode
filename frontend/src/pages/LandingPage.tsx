import { WaynodeMark } from "../components/Brand";
import { LoginPage } from "./LoginPage";

const PLANS = [
  { name: "Starter", price: "$39", detail: "For a focused build loop", specs: ["3 seats", "3M agent tokens / month", "10 GB workspace storage"] },
  { name: "Pro", price: "$99", detail: "For the team that ships daily", specs: ["10 seats", "8M agent tokens / month", "50 GB workspace storage"], featured: true },
  { name: "Team", price: "$249", detail: "For the whole engineering team", specs: ["25 seats", "20M agent tokens / month", "200 GB workspace storage"] },
];

const WORKFLOW = [
  ["01", "Connect a repository", "Choose GitHub or GitLab, then give every repository its own space."],
  ["02", "Give the agent real work", "Chat through an edit, send an autonomous goal, or take over in the full terminal."],
  ["03", "Review and ship", "Inspect the live diff, edit changed files, commit, push, and keep the whole team aligned."],
];

export function LandingPage() {
  return (
    <main className="landing-page">
      <header className="landing-nav">
        <a className="landing-nav-brand" href="#top" aria-label="Waynode home">
          <WaynodeMark size={28} /> <span>Waynode</span>
        </a>
        <nav className="landing-nav-actions" aria-label="Primary navigation">
          <a href="#pricing">Pricing</a>
          <a href="#self-host">Self-host</a>
          <a className="landing-nav-github" href="https://github.com/fornace/waynode" target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
      </header>

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <div className="landing-eyebrow"><span /> An agent workspace that is actually yours</div>
          <h1>Give your coding agent a real place to work.</h1>
          <p>Waynode puts every agent in a real cloned repository—with the chat, terminal, git history, and team context needed to turn a request into a reviewable change.</p>
          <div className="landing-hero-actions">
            <a className="landing-button landing-button-primary" href="#auth">Start hosted free <span>→</span></a>
            <a className="landing-button landing-button-secondary" href="#self-host">Self-host Waynode <span>→</span></a>
          </div>
          <div className="landing-hero-note"><span className="landing-check">✓</span> 15 days on hosted, no card required <span aria-hidden="true">·</span> MIT licensed forever</div>
        </div>
        <div className="landing-hero-visual" aria-label="Waynode workspace preview">
          <div className="landing-orbit landing-orbit-one" /><div className="landing-orbit landing-orbit-two" />
          <BrowserFrame src="/marketing/screenshot-chat.png" alt="Waynode chat view with an active coding-agent session" url="waynode.app/acme/api" caption="A real workspace for every repo—not another chat window." priority />
          <div className="landing-floating-card landing-floating-status"><span className="landing-pulse" /> Goal in progress <b>Reviewing changes</b></div>
          <div className="landing-floating-card landing-floating-git"><span>⌘</span><div><strong>12 files changed</strong><small>Ready for review</small></div></div>
        </div>
      </section>

      <section className="landing-proof" aria-label="Waynode capabilities">
        <span>Real git clones</span><span>Full agent terminal</span><span>Mobile-ready</span><span>Team workspaces</span><span>Open source</span>
      </section>

      <section className="landing-choice" aria-labelledby="choice-heading">
        <div className="landing-section-intro"><p className="landing-kicker">Choose your control plane</p><h2 id="choice-heading">Use Waynode your way.</h2><p>Start fast on our hosted service, or keep every byte in infrastructure you control. The agent workspace stays the same.</p></div>
        <div className="landing-choice-grid">
          <article className="landing-choice-card landing-choice-hosted">
            <div className="landing-choice-icon">☁</div><p className="landing-card-label">WAYNODE CLOUD</p><h3>Hosted by us. Ready in minutes.</h3><p>We run the workspace, encrypted secrets, updates, and billing so your team can focus on shipping.</p>
            <ul><li>15-day free trial, no card required</li><li>Pay securely on the web or through the App Store</li><li>Managed updates and support</li></ul>
            <a className="landing-text-link" href="#auth">Start your hosted trial <span>→</span></a>
          </article>
          <article className="landing-choice-card">
            <div className="landing-choice-icon landing-choice-icon-code">⌘</div><p className="landing-card-label">SELF-HOSTED</p><h3>Your infrastructure. Your rules.</h3><p>Run the open-source stack wherever your code needs to live—your laptop, VPC, or your own private cloud.</p>
            <ul><li>MIT licensed and fully inspectable</li><li>Bring your own models and credentials</li><li>No hosted subscription required</li></ul>
            <a className="landing-text-link" href="#self-host">Read the install guide <span>→</span></a>
          </article>
        </div>
      </section>

      <section className="landing-product-section">
        <div className="landing-section-intro landing-section-intro-left"><p className="landing-kicker">An agent workflow with receipts</p><h2>From idea to pull request, without losing the plot.</h2></div>
        <div className="landing-workflow">{WORKFLOW.map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
        <div className="landing-showcase-grid">
          <BrowserFrame src="/marketing/screenshot-spaces.png" alt="Waynode sidebar showing spaces and sessions" url="waynode.app/spaces" caption="Spaces keep repositories and agent conversations organized." />
          <BrowserFrame src="/marketing/screenshot-terminal.png" alt="Waynode terminal tab running pi's TUI" url="waynode.app/terminal" caption="Take the controls in a real PTY—not a toy shell." />
        </div>
      </section>

      <section className="landing-safety">
        <div><p className="landing-kicker">Built to be trusted with your code</p><h2>Useful agents need thoughtful guardrails.</h2><p>Waynode keeps work visible and access scoped: real git diffs before you ship, role-based team access, encrypted secrets, and per-space isolation.</p></div>
        <div className="landing-safety-list"><div><b>◈</b><span><strong>Reviewable by default</strong><small>See exactly what an agent changed before it leaves the workspace.</small></span></div><div><b>⌁</b><span><strong>Secrets stay encrypted</strong><small>Credentials are encrypted at rest and injected only when an agent runs.</small></span></div><div><b>⊞</b><span><strong>Teams without overreach</strong><small>Invite collaborators with roles, then keep spaces private by default.</small></span></div></div>
      </section>

      <section className="landing-pricing" id="pricing">
        <div className="landing-section-intro"><p className="landing-kicker">Simple hosted pricing</p><h2>Pick the room your team needs.</h2><p>Every hosted plan begins with 15 free days. Upgrade only when Waynode earns its place in your workflow.</p></div>
        <div className="landing-pricing-grid">{PLANS.map((plan) => <article className={`landing-price-card ${plan.featured ? "landing-price-featured" : ""}`} key={plan.name}>{plan.featured && <div className="landing-popular">Most popular</div>}<h3>{plan.name}</h3><p>{plan.detail}</p><div className="landing-price"><strong>{plan.price}</strong><span>/ month</span></div><ul>{plan.specs.map((spec) => <li key={spec}>✓ {spec}</li>)}</ul><a className={plan.featured ? "landing-button landing-button-primary" : "landing-button landing-button-secondary"} href="#auth">Start free trial <span>→</span></a></article>)}</div>
        <p className="landing-pricing-footnote">Web checkout is powered by Stripe. Mobile subscriptions are available through the App Store where supported.</p>
      </section>

      <section className="landing-self-host" id="self-host"><div><p className="landing-kicker">Self-hosted is a first-class path</p><h2>Keep the workspace close to the code.</h2><p>Clone Waynode, configure your OAuth application and encryption key, then run it with your own repositories, models, and network controls.</p><a className="landing-button landing-button-secondary" href="https://github.com/fornace/waynode#readme" target="_blank" rel="noreferrer">Read self-hosting docs <span>→</span></a></div><pre aria-label="Self-host installation command"><code><span>$</span> git clone https://github.com/fornace/waynode<br /><span>$</span> cd waynode && npm install<br /><span>$</span> npm start</code></pre></section>

      <section className="landing-auth" id="auth"><div className="landing-auth-copy"><p className="landing-kicker">Start where you are</p><h2>Make your next agent task easy to review.</h2><p>Sign in to begin your hosted trial. Prefer full infrastructure control? Self-host Waynode instead.</p></div><LoginPage /></section>

      <footer className="landing-footer"><a className="landing-nav-brand" href="#top"><WaynodeMark size={24} /><span>Waynode</span></a><span>Open source agent workspaces for teams that ship.</span><div><a href="https://github.com/fornace/waynode" target="_blank" rel="noreferrer">GitHub</a><a href="https://github.com/fornace/waynode#readme" target="_blank" rel="noreferrer">Docs</a></div></footer>
    </main>
  );
}

function BrowserFrame({ src, alt, url, caption, priority = false }: { src: string; alt: string; url: string; caption: string; priority?: boolean }) {
  return <figure className="browser-frame"><div className="browser-frame-chrome"><span className="browser-frame-dot browser-frame-dot-red" /><span className="browser-frame-dot browser-frame-dot-amber" /><span className="browser-frame-dot browser-frame-dot-green" /><span className="browser-frame-url">{url}</span></div><img className="browser-frame-img" src={src} alt={alt} loading={priority ? "eager" : "lazy"} /><figcaption>{caption}</figcaption></figure>;
}
