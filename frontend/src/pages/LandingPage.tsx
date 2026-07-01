import { WaynodeMark } from "../components/Brand";
import { LoginPage } from "./LoginPage";

const FEATURES = [
  {
    title: "Real cloned repos, not sandboxes",
    desc: "Every space is an actual git clone on disk — your code, your history, your branches. No black-box VM abstraction in the way.",
  },
  {
    title: "A coding agent per space",
    desc: "Each session is a conversation with pi, a persistent agent process that lives on the server and survives client navigation. Chat mode streams responses over SSE; Goal mode runs it autonomously.",
  },
  {
    title: "Full terminal, not a toy shell",
    desc: "Drop into pi's real TUI over an actual pty — node-pty piped through a WebSocket to xterm.js. Model switching, `/goal`, raw power, no compromises.",
  },
  {
    title: "Git built in",
    desc: "Commit, push, and pull without leaving the workspace, with a live diff and status view so you always see what the agent changed before it ships.",
  },
  {
    title: "Built for teams, built for phones",
    desc: "Organizations, invites, and role-based access for small teams — with a mobile-first responsive UI that works as well on a phone as a desktop.",
  },
];

export function LandingPage() {
  return (
    <div className="landing-page">
      <header className="landing-nav">
        <div className="landing-nav-brand">
          <WaynodeMark size={26} />
          <span>Waynode</span>
        </div>
        <a
          className="landing-nav-link"
          href="https://github.com/fornace/waynode"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <WaynodeMark size={56} spin />
          <h1>
            Your coding agent,
            <br />
            self-hosted.
          </h1>
          <p className="landing-hero-sub">
            Open-source workspace for AI coding agents. Every space is a real
            cloned repo. Chat, run autonomous goals, or drop into a full
            terminal — all from your phone or your desktop.
          </p>
          <div className="landing-hero-badges">
            <span className="landing-badge">Open source</span>
            <span className="landing-badge">Self-hosted</span>
            <span className="landing-badge">Mobile-first</span>
          </div>
          <a className="landing-cta" href="#auth">
            Get started
          </a>
        </div>
      </section>

      <section className="landing-features">
        <h2>What you actually get</h2>
        <div className="landing-features-grid">
          {FEATURES.map((f) => (
            <div className="landing-feature-card" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-showcase">
        <h2>See it in action</h2>
        <div className="landing-showcase-grid">
          <BrowserFrame
            src="/marketing/screenshot-spaces.png"
            alt="Waynode sidebar showing spaces and sessions"
            url="waynode.local/spaces"
            caption="Spaces &amp; sessions — one sidebar, every repo you're working in"
          />
          <BrowserFrame
            src="/marketing/screenshot-chat.png"
            alt="Waynode chat view with an active coding-agent session"
            url="waynode.local/waynode/session"
            caption="Chat with the agent, or hand it a goal and let it run"
          />
          <BrowserFrame
            src="/marketing/screenshot-terminal.png"
            alt="Waynode terminal tab running pi's TUI"
            url="waynode.local/waynode/session"
            caption="Drop into a real terminal — pi's full TUI, over a real pty"
          />
        </div>
      </section>

      <section className="landing-auth" id="auth">
        <h2>Sign in to your workspace</h2>
        <LoginPage />
      </section>

      <footer className="landing-footer">
        <div>MIT licensed. Self-host it, fork it, ship it.</div>
        <div className="landing-footer-links">
          <a href="https://github.com/fornace/waynode" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://github.com/fornace/waynode#readme" target="_blank" rel="noreferrer">
            Docs
          </a>
          <a href="https://github.com/fornace/waynode/blob/main/AGENTS.md" target="_blank" rel="noreferrer">
            Architecture
          </a>
        </div>
      </footer>
    </div>
  );
}

function BrowserFrame({
  src,
  alt,
  url,
  caption,
}: {
  src: string;
  alt: string;
  url: string;
  caption: string;
}) {
  return (
    <figure className="browser-frame">
      <div className="browser-frame-chrome">
        <span className="browser-frame-dot browser-frame-dot-red" />
        <span className="browser-frame-dot browser-frame-dot-amber" />
        <span className="browser-frame-dot browser-frame-dot-green" />
        <span className="browser-frame-url">{url}</span>
      </div>
      <img className="browser-frame-img" src={src} alt={alt} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
