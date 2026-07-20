import { useEffect, useState } from "react";
import { WaynodeMark } from "../components/Brand";

const selfHostGuide = "https://github.com/Fornace/waynode/blob/main/docs/SELF-HOSTING.md";
const pricingDoc = "https://github.com/Fornace/waynode/blob/main/docs/PRICING.md";
const githubRepo = "https://github.com/Fornace/waynode";

const beats = [
  { id: "brief", label: "Brief", index: "01" },
  { id: "verified-run", label: "Verified run", index: "02" },
  { id: "evidence", label: "Evidence", index: "03" },
  { id: "handoff", label: "Handoff", index: "04" },
  { id: "deployment", label: "Deployment", index: "05" },
];

const sessionRows = [
  { label: "Worktree", value: "example/checkout-service · main" },
  { label: "Session", value: "Recover checkout retries" },
  { label: "Run", value: "hammersmith · 7/7 checks passed" },
  { label: "Changed files", value: "3" },
];

const changedFiles = [
  { path: "src/checkout/retry.ts", delta: "+3 −1" },
  { path: "src/checkout/client.ts", delta: "+2 −0" },
  { path: "test/checkout-retries.test.ts", delta: "+4 −0" },
];

function useActiveBeat() {
  const [active, setActive] = useState(beats[0].id);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-35% 0px -55% 0px" },
    );
    for (const beat of beats) {
      const section = document.getElementById(beat.id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);
  return active;
}

export function LandingPage() {
  const activeBeat = useActiveBeat();

  return (
    <main className="product-page" id="top">
      <a className="skip-link" href="#product-content">Skip to main content</a>

      <nav className="product-rail" aria-label="The life of one job">
        <p className="product-rail-label">One job</p>
        <ol>
          {beats.map((beat) => (
            <li key={beat.id}>
              <a href={`#${beat.id}`} className={activeBeat === beat.id ? "active" : ""}>
                <span>{beat.label}</span>
                <span className="product-rail-index">{beat.index}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <header className="product-nav">
        <a className="product-brand" href="#top" aria-label="Waynode home">
          <WaynodeMark size={30} tension />
          <span>Waynode</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="/learn">Guides</a>
          <a href={githubRepo}>GitHub</a>
          <a className="product-sign-in" href="/login">Sign in</a>
        </nav>
      </header>

      <section className="product-hero" id="brief" aria-labelledby="brief-title">
        <div className="product-hero-copy" id="product-content" tabIndex={-1}>
          <p className="product-eyebrow">The life of one job</p>
          <h1 id="brief-title">Leave the laptop.<br /><span>Not the worktree.</span></h1>
          <p className="product-lede">
            Waynode keeps a durable cloned repository and a server-resident coding agent
            together, and holds on to the Git evidence every run leaves behind.
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
        </div>

        <figure className="frame frame-tri-selector">
          <div className="frame-body" aria-hidden="true">
            <div className="frame-context">
              <span>Waynode Lab</span>
              <span>example/checkout-service · main</span>
            </div>
            <div className="composer">
              <p className="composer-text">
                Make checkout retries idempotent and add timeout coverage
                <span className="composer-caret" />
              </p>
              <div className="composer-bar">
                <p className="tri-selector">
                  <span>message</span>
                  <span>goal</span>
                  <span className="selected">hammersmith</span>
                </p>
                <span className="composer-send">Send</span>
              </div>
            </div>
          </div>
          <figcaption>
            Sent as hammersmith, the message is not a chat prompt. It is a job
            description for a verified swarm.
          </figcaption>
        </figure>
      </section>

      <section className="product-section" id="verified-run" aria-labelledby="run-title">
        <div className="product-section-copy">
          <p className="product-eyebrow">Verified run</p>
          <h2 id="run-title">Delegated, then verified.</h2>
          <p>
            A hammersmith run fans the job out to a swarm of workers. Each task comes
            back with checks that were executed, and the run counts them in plain text.
          </p>
        </div>
        <figure className="frame frame-verified-run">
          <div className="frame-body" aria-hidden="true">
            <div className="run-head">
              <span>hammersmith run · Recover checkout retries</span>
              <span className="run-count">5/7 checks</span>
            </div>
            <div className="run-progress"><span /></div>
            <ul className="run-tasks">
              <li className="run-task">
                <span className="run-task-name">Make charge retries idempotent</span>
                <span className="run-task-count">2/2 checks</span>
                <span className="run-check">
                  <span className="run-check-running">running</span>
                  <span className="run-check-passed">passed</span>
                </span>
              </li>
              <li className="run-task">
                <span className="run-task-name">Record idempotency keys in the store</span>
                <span className="run-task-count">1/1 checks</span>
                <span className="run-check">
                  <span className="run-check-running">running</span>
                  <span className="run-check-passed">passed</span>
                </span>
              </li>
              <li className="run-task active">
                <span className="run-task-name">Add timeout coverage to client calls</span>
                <span className="run-task-count">1/2 checks</span>
                <span className="run-check-static">running</span>
              </li>
              <li className="run-task">
                <span className="run-task-name">Cover the stalled-charge path</span>
                <span className="run-task-count">1/1 checks</span>
                <span className="run-check">
                  <span className="run-check-running">running</span>
                  <span className="run-check-passed">passed</span>
                </span>
              </li>
              <li className="run-task">
                <span className="run-task-name">Verify retry paths under lock</span>
                <span className="run-task-count">0/1 checks</span>
                <span className="run-check-static">queued</span>
              </li>
            </ul>
          </div>
          <figcaption>
            Delegated work returns verified by executed checks, not by a reassuring
            message.
          </figcaption>
        </figure>
      </section>

      <section className="product-section" id="evidence" aria-labelledby="evidence-title">
        <div className="product-section-copy">
          <p className="product-eyebrow">Evidence</p>
          <h2 id="evidence-title">The worktree is the product.</h2>
          <p>
            The run ends in the worktree it started from. Three files changed, and the
            review inspector sits beside the session that changed them.
          </p>
        </div>
        <figure className="frame frame-evidence">
          <div className="frame-body evidence-grid" aria-hidden="true">
            <ul className="evidence-session">
              {sessionRows.slice(0, 3).map((row) => (
                <li key={row.label}><span>{row.label}</span><span>{row.value}</span></li>
              ))}
            </ul>
            <div className="evidence-review">
              <div className="review-head">
                <span>Review</span>
                <span>3 changed files</span>
              </div>
              <ul className="review-files">
                {changedFiles.map((file) => (
                  <li key={file.path}><span>{file.path}</span><span>{file.delta}</span></li>
                ))}
              </ul>
              <pre className="review-diff"><code>
                <span className="diff-line">  const key = idempotencyKey(order.id, attempt);</span>
                <span className="diff-line diff-add">+ if (await store.has(key)) return store.result(key);</span>
                <span className="diff-line diff-del">- const charge = await client.charge(order);</span>
                <span className="diff-line diff-add">+ const charge = await client.charge(order, timeoutOpts);</span>
                <span className="diff-line diff-add">+ await store.record(key, charge);</span>
                <span className="diff-line">  return charge;</span>
              </code></pre>
            </div>
          </div>
          <figcaption>
            Done is a diff you can inspect before you commit. The worktree is the
            product.
          </figcaption>
        </figure>
      </section>

      <section className="product-section" id="handoff" aria-labelledby="handoff-title">
        <div className="product-section-copy">
          <p className="product-eyebrow">Handoff</p>
          <h2 id="handoff-title">Close the laptop. Open the phone.</h2>
          <p>
            The session lives on the server, next to the worktree. Another device
            reopens it exactly where it was.
          </p>
        </div>
        <figure className="frame frame-handoff">
          <div className="frame-body handoff-grid" aria-hidden="true">
            <div className="handoff-device handoff-desktop">
              <p className="handoff-device-label">macOS</p>
              <ul>
                {sessionRows.map((row) => (
                  <li key={row.label}><span>{row.label}</span><span>{row.value}</span></li>
                ))}
              </ul>
            </div>
            <div className="handoff-device handoff-phone">
              <p className="handoff-device-label">iOS</p>
              <ul>
                {sessionRows.map((row) => (
                  <li key={row.label}><span>{row.label}</span><span>{row.value}</span></li>
                ))}
              </ul>
            </div>
          </div>
          <figcaption>
            The native iOS and macOS client draws the same session. Nothing to
            reconstruct.
          </figcaption>
        </figure>
      </section>

      <section className="product-section" id="deployment" aria-labelledby="deploy-title">
        <div className="product-section-copy">
          <p className="product-eyebrow">Deployment</p>
          <h2 id="deploy-title">One product. Two operating boundaries.</h2>
          <p>
            Cloud and self-hosted run the same open-source Waynode stack. The choice is
            who operates the server, storage, credentials, and backups.
          </p>
        </div>
        <div className="product-deployments">
          <article>
            <p className="product-card-label">Managed</p>
            <h3>Waynode Cloud</h3>
            <p>Waynode operates the service: updates, isolated workspaces, encrypted secrets, and billing.</p>
            <ul className="product-facts">
              <li>15-day trial, then Starter $39, Pro $99, or Team $249 per month</li>
              <li>Hammersmith verified-swarm tier at $8.99 per month</li>
              <li>Terminal stays off on hosted worktrees</li>
            </ul>
            <a href="/login">Start hosted trial</a>
          </article>
          <article>
            <p className="product-card-label">Operator-owned</p>
            <h3>Self-hosted</h3>
            <p>You run the same stack on your own infrastructure and keep its operational boundary yours.</p>
            <ul className="product-facts">
              <li>Free and open-source under the MIT license</li>
              <li>Your model keys, your network policy, your backups</li>
              <li>Interactive workspace terminal included</li>
            </ul>
            <a href={selfHostGuide}>Read the install guide</a>
          </article>
        </div>
        <div className="product-install" aria-label="Self-host installation command">
          <span>Guided Docker Compose setup</span>
          <code>./scripts/self-host.sh setup</code>
        </div>
        <p className="product-cost-note">
          Hosted pricing is documented line by line, including the cost math, in{" "}
          <a href={pricingDoc}>the public pricing doc</a>.
        </p>
      </section>

      <footer className="product-footer">
        <a className="product-brand" href="#top">
          <WaynodeMark size={25} />
          <span>Waynode</span>
        </a>
        <span>Open-source durable worktrees for coding agents.</span>
        <nav aria-label="Footer">
          <a href={githubRepo}>GitHub</a>
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
