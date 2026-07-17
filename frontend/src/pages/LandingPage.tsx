import { WaynodeMark } from "../components/Brand";

const selfHostGuide = "https://github.com/Fornace/waynode/blob/main/docs/SELF-HOSTING.md";

const continuityCaptures = [
  {
    label: "Start · Mac",
    title: "Direct the work",
    copy: "The repository, branch, session, and run state stay in one frame.",
    src: "/marketing/worktree-session-desktop.png",
    className: "product-capture-mac",
  },
  {
    label: "Return · iPhone",
    title: "Read the same session",
    copy: "The conversation and current worktree state are waiting on the phone.",
    src: "/marketing/worktree-session-phone.png",
    className: "product-capture-phone",
  },
  {
    label: "Review · iPad",
    title: "Inspect what changed",
    copy: "Changed files and their diff stay beside the session that produced them.",
    src: "/marketing/worktree-review-tablet.png",
    className: "product-capture-tablet",
  },
];

export function LandingPage() {
  return (
    <main className="product-page" id="top">
      <a className="skip-link" href="#product-content">Skip to main content</a>

      <header className="product-nav">
        <a className="product-brand" href="#top" aria-label="Waynode home">
          <WaynodeMark size={30} tension />
          <span>Waynode</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#continuity">Continuity</a>
          <a href="#review">Review</a>
          <a href="#deployment">Deployment</a>
          <a href="/learn">Guides</a>
          <a className="product-sign-in" href="/login">Sign in</a>
        </nav>
      </header>

      <section className="product-hero" id="product-content" tabIndex={-1}>
        <div className="product-hero-copy">
          <p className="product-eyebrow">A durable worktree for agent work</p>
          <h1>Leave the laptop.<br /><span>Not the worktree.</span></h1>
          <p className="product-lede">
            A real cloned repository, a server-resident coding agent, and the Git evidence
            it leaves behind—kept together when you close one device and open another.
          </p>
          <div className="product-actions">
            <a className="product-primary" href="/login">Start 15-day hosted trial</a>
            <a className="product-secondary" href={selfHostGuide}>Self-host Waynode</a>
          </div>
          <ul className="product-proof" aria-label="Waynode product facts">
            <li>Real Git worktrees</li>
            <li>GitHub and GitLab</li>
            <li>MIT licensed</li>
          </ul>
          <ol className="product-provenance" aria-label="Waynode continuity path">
            <li><span>01</span><div><b>Repository</b><small>A real clone on the server</small></div></li>
            <li><span>02</span><div><b>Branch</b><small>The exact line of work</small></div></li>
            <li><span>03</span><div><b>Session</b><small>Direction and run state</small></div></li>
            <li><span>04</span><div><b>Changes</b><small>Diff evidence ready to review</small></div></li>
          </ol>
        </div>

        <figure className="product-hero-capture">
          <div className="product-capture-context"><span>Worktree evidence</span><code>repo / branch / session / changes</code></div>
          <img
            src="/marketing/worktree-session-desktop.png"
            alt="Waynode session showing repository identity, an agent response, and changed files ready for review"
            width="1440"
            height="900"
            fetchPriority="high"
          />
          <figcaption>One session. Its repository, branch, run state, and review entry point.</figcaption>
        </figure>
      </section>

      <section className="product-section" id="continuity">
        <div className="product-section-copy">
          <p className="product-eyebrow">Continuity</p>
          <h2>The client can leave. The work stays put.</h2>
          <p>
            Waynode keeps the agent on the server beside the same worktree. Return from a
            desktop, phone, or tablet without reconstructing the task from a disposable thread.
          </p>
        </div>
        <p className="product-continuity-note"><span aria-hidden="true" />One worktree identity, carried across every device.</p>
        <div className="product-continuity-grid">
          {continuityCaptures.map((capture) => (
            <figure className={`product-device-capture ${capture.className}`} key={capture.label}>
              <div className="product-capture-label">{capture.label}</div>
              <img src={capture.src} alt="" loading="lazy" />
              <figcaption><strong>{capture.title}</strong><span>{capture.copy}</span></figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="product-review" id="review">
        <div className="product-review-copy">
          <p className="product-eyebrow">Review</p>
          <h2>The worktree is the product.</h2>
          <p>
            “Done” is not a reassuring chat message. It is a branch you can inspect before
            you commit and push.
          </p>
          <dl>
            <div><dt>Repository + branch</dt><dd>Identity remains visible while the agent works.</dd></div>
            <div><dt>Changed files + diff</dt><dd>Review the evidence beside the conversation.</dd></div>
            <div><dt>Commit + push</dt><dd>Git mutations follow review in the same worktree.</dd></div>
          </dl>
        </div>
        <figure className="product-review-capture">
          <img
            src="/marketing/worktree-review-tablet.png"
            alt="Waynode review inspector showing changed files and a source diff"
            width="768"
            height="1024"
            loading="lazy"
          />
          <figcaption>Review is attached to the session, not buried in a separate tool.</figcaption>
        </figure>
      </section>

      <section className="product-section" id="deployment">
        <div className="product-section-copy">
          <p className="product-eyebrow">Deployment</p>
          <h2>One product. Two clear operating boundaries.</h2>
          <p>
            Cloud and self-hosted run the same open-source Waynode stack. Choose who should
            operate the server, storage, credentials, network, and backups.
          </p>
        </div>
        <div className="product-deployments">
          <article>
            <p className="product-card-label">Managed</p>
            <h3>Waynode Cloud</h3>
            <p>Waynode operates the service while you connect repositories and review agent work.</p>
            <dl>
              <div><dt>Execution</dt><dd>Hardware-isolated agent runs</dd></div>
              <div><dt>Operations</dt><dd>Service, updates, encrypted secrets, and billing</dd></div>
              <div><dt>Terminal</dt><dd>Not available on hosted worktrees</dd></div>
            </dl>
            <a href="/login">Start hosted trial</a>
          </article>
          <article>
            <p className="product-card-label">Operator-owned</p>
            <h3>Self-hosted</h3>
            <p>You run Waynode on your infrastructure and keep its operational boundary yours.</p>
            <dl>
              <div><dt>Execution</dt><dd>Your model providers and network policy</dd></div>
              <div><dt>Operations</dt><dd>You own HTTPS, upgrades, and backups</dd></div>
              <div><dt>Terminal</dt><dd>Interactive workspace terminal included</dd></div>
            </dl>
            <a href={selfHostGuide}>Read the install guide</a>
          </article>
        </div>
        <div className="product-install" aria-label="Self-host installation command">
          <span>Guided Docker Compose setup</span>
          <code>./scripts/self-host.sh setup</code>
        </div>
      </section>

      <footer className="product-footer">
        <a className="product-brand" href="#top">
          <WaynodeMark size={25} />
          <span>Waynode</span>
        </a>
        <span>Open-source durable worktrees for coding agents.</span>
        <nav aria-label="Footer">
          <a href="https://github.com/Fornace/waynode">GitHub</a>
          <a href="/learn">Guides</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/security">Security</a>
          <a href="/support">Support</a>
          <a href="/status">Status</a>
        </nav>
      </footer>
    </main>
  );
}
