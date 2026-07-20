import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import type { HammersmithCapability } from "../types";
import hammersmithSetup from "../assets/hammersmith-setup.svg";
import githubReadiness from "../assets/github-readiness.svg";

interface OnboardingWizardProps {
  githubConnected: boolean;
  gitlabConnected: boolean;
  cloning: boolean;
  error?: string;
  onClone: (repoUrl: string, branch: string) => Promise<void>;
}

export function OnboardingWizard({ githubConnected, gitlabConnected, cloning, error, onClone }: OnboardingWizardProps) {
  const { availableProviders } = useAuth();
  const [complete, setComplete] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [capability, setCapability] = useState<HammersmithCapability | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [copied, setCopied] = useState(false);
  const connected = [githubConnected && "GitHub", gitlabConnected && "GitLab"].filter(Boolean);
  const hammersmithState = capabilityError ? "request-error"
    : !capability ? "checking"
      : capability.available ? "ready" : capability.state || "unsupported";
  const environmentReady = hammersmithState === "ready" && githubConnected;

  const checkHammersmith = async () => {
    setCapability(null);
    setCapabilityError("");
    try { setCapability(await api.hammersmith.capability()); }
    catch { setCapabilityError("Waynode could not check Hammersmith. Check the connection and try again."); }
  };

  useEffect(() => { void checkHammersmith(); }, []);

  const copyInstall = async () => {
    await navigator.clipboard.writeText("pip install hammersmith");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const clone = async (event: FormEvent) => {
    event.preventDefault();
    if (!repoUrl.trim() || cloning) return;
    try {
      await onClone(repoUrl.trim(), branch.trim() || "main");
      setComplete(true);
    } catch {}
  };

  return (
    <main className="onboarding" aria-labelledby="onboarding-title">
      <section className="onboarding-card">
        <div className="onboarding-kicker">First worktree</div>
        <div className="onboarding-progress" aria-label={complete ? "Step 2 of 2" : "Step 1 of 2"}>
          <span className="complete" /><span className={complete ? "complete" : ""} />
        </div>

        {!complete ? <>
          <h1 id="onboarding-title">Get the workspace ready</h1>
          <p className="onboarding-intro">Prepare verified delegation and GitHub access, then clone the repository for this durable worktree.</p>
          {environmentReady ? (
            <div className="onboarding-env-ready">Environment ready — Hammersmith and GitHub are connected.</div>
          ) : (
          <div className="onboarding-guides">
            <article className="onboarding-guide" aria-labelledby="hammersmith-guide-title">
              <img src={hammersmithSetup} alt="" />
              <div className="onboarding-guide-status">{{
                checking: "Checking…", ready: "Ready", "setup-required": "Setup needed",
                unsupported: "Unsupported", "request-error": "Check failed",
              }[hammersmithState]}</div>
              <h2 id="hammersmith-guide-title">Hammersmith readiness</h2>
              {hammersmithState === "checking" && <p>Waynode is checking the Hammersmith runtime and execution environment.</p>}
              {hammersmithState === "ready" && <p>Hammersmith is available in the environment checked by Waynode.</p>}
              {hammersmithState === "setup-required" && <>
                <p>Hammersmith was not detected in the environment checked by Waynode. Install it there, then check again.</p>
                <code className="onboarding-command">pip install hammersmith</code>
                <p className="onboarding-caution">The generic command may be unavailable. Self-hosted production must use the locally pinned package path under <code>vendor/hammersmith</code> and verify its recorded checksum.</p>
              </>}
              {hammersmithState === "unsupported" && <p>The package is installed, but this server cannot provide the required sandbox/KVM runtime. Ask the administrator to enable the supported execution environment.</p>}
              {hammersmithState === "request-error" && <p className="onboarding-error" role="alert">{capabilityError}</p>}
              <div className="onboarding-guide-actions">
                {hammersmithState === "setup-required" && <button type="button" onClick={copyInstall}>{copied ? "Copied" : "Copy install command"}</button>}
                <a href="https://github.com/Fornace/hammersmith" target="_blank" rel="noopener noreferrer">View Hammersmith repository</a>
                <button type="button" onClick={checkHammersmith}>Check again</button>
              </div>
              {hammersmithState === "setup-required" && <p className="onboarding-caution">If this workspace is managed for you, ask its administrator to install the pinned runtime in the environment checked by Waynode.</p>}
            </article>

            <article className="onboarding-guide" aria-labelledby="github-guide-title">
              <img src={githubReadiness} alt="" />
              <div className="onboarding-guide-status">{githubConnected ? "Ready" : "Action needed"}</div>
              <h2 id="github-guide-title">Get GitHub ready</h2>
              <p>Connect GitHub to browse and clone repositories from this Waynode server. Start with OAuth; use a personal access token (PAT) only when needed.</p>
              {githubConnected ? <p className="onboarding-ready">GitHub is connected.</p> : availableProviders.github ? (
                <a className="onboarding-oauth" href="/auth/github">Connect GitHub</a>
              ) : <p className="onboarding-caution">GitHub OAuth is not configured on this server. Ask its administrator to enable GitHub, or open the optional PAT guidance.</p>}
              <details className="onboarding-pat">
                <summary>Use a PAT only if needed</summary>
                <p>Open this only when OAuth is unavailable or your administrator requires a token.</p>
                <strong>Treat a PAT like a password; never put it in a URL, command, chat, screenshot, or illustration; enter it only in the existing password/access-token field or encrypted <code>GITHUB_TOKEN</code> secret. Waynode will not show a saved secret value again.</strong>
              </details>
            </article>
          </div>
          )}

          {connected.length > 0 && <div className="onboarding-connected">Connected: {connected.join(" · ")}</div>}
          <form className="onboarding-form" onSubmit={clone}>
            <label>Repository URL
              <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/you/project.git" required />
            </label>
            <label>Branch <span>optional</span>
              <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
            </label>
            {error && <p className="onboarding-error" role="alert">{error}</p>}
            <button className="onboarding-primary" disabled={cloning || !repoUrl.trim()}>{cloning ? "Cloning worktree…" : "Clone repository"}</button>
          </form>
          <p className="onboarding-note">Private repositories use your connected GitHub or GitLab account. Clone progress remains visible while the server works.</p>
        </> : <>
          <h1 id="onboarding-title">Worktree ready</h1>
          <p className="onboarding-intro">The first session is open with the repository and branch attached. Describe the outcome you want, then review the changed files before committing.</p>
        </>}
      </section>
    </main>
  );
}
