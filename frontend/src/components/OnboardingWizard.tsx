import { useState, type FormEvent } from "react";

type SetupPath = "cloud" | "self-hosted" | null;

interface OnboardingWizardProps {
  githubConnected: boolean;
  gitlabConnected: boolean;
  cloning: boolean;
  error?: string;
  onClone: (repoUrl: string, branch: string) => Promise<void>;
}

/**
 * A deliberately small first-run guide. It does not create an account, change a
 * plan, or bypass the regular repo flow: a clone still travels through the same
 * API used by the sidebar picker. The chosen hosting path is only a preference
 * so a self-hosted deployment never unexpectedly turns on hosted billing.
 */
export function OnboardingWizard({
  githubConnected,
  gitlabConnected,
  cloning,
  error,
  onClone,
}: OnboardingWizardProps) {
  const [path, setPath] = useState<SetupPath>(() => {
    const saved = localStorage.getItem("waynode-onboarding-path");
    return saved === "cloud" || saved === "self-hosted" ? saved : null;
  });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");

  const choosePath = (next: Exclude<SetupPath, null>) => {
    setPath(next);
    localStorage.setItem("waynode-onboarding-path", next);
  };

  const continueToRepository = () => setStep(2);

  const clone = async (event: FormEvent) => {
    event.preventDefault();
    if (!repoUrl.trim() || cloning) return;
    try {
      await onClone(repoUrl.trim(), branch.trim() || "main");
      setStep(3);
    } catch {
      // The parent provides an actionable error message without replacing the
      // user's URL or branch choice.
    }
  };

  return (
    <main className="onboarding" aria-labelledby="onboarding-title">
      <section className="onboarding-card">
        <div className="onboarding-kicker">First workspace</div>
        <div className="onboarding-progress" aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((number) => <span key={number} className={number <= step ? "complete" : ""} />)}
        </div>

        {step === 1 && (
          <>
            <h1 id="onboarding-title">Where will you run Waynode?</h1>
            <p className="onboarding-intro">Choose the setup that fits your team. You can always clone a repository next.</p>
            <div className="onboarding-options">
              <button className={`onboarding-option ${path === "cloud" ? "selected" : ""}`} onClick={() => choosePath("cloud")}>
                <span className="onboarding-option-icon">☁</span>
                <span><strong>Waynode Cloud</strong><small>Managed workspaces and billing from your account.</small></span>
              </button>
              <button className={`onboarding-option ${path === "self-hosted" ? "selected" : ""}`} onClick={() => choosePath("self-hosted")}>
                <span className="onboarding-option-icon">⌘</span>
                <span><strong>Self-hosted</strong><small>Run Waynode on infrastructure you control.</small></span>
              </button>
            </div>
            {path === "self-hosted" && (
              <a className="onboarding-doc-link" href="https://github.com/Fornace/waynode#readme" target="_blank" rel="noreferrer">Read the self-hosting guide ↗</a>
            )}
            <button className="onboarding-primary" disabled={!path} onClick={continueToRepository}>Continue</button>
            <p className="onboarding-note">This choice is only saved in this browser. It does not start a subscription.</p>
          </>
        )}

        {step === 2 && (
          <>
            <button className="onboarding-back" onClick={() => setStep(1)}>← Back</button>
            <h1 id="onboarding-title">Bring your repository</h1>
            <p className="onboarding-intro">Paste any Git URL. Private repositories work with the existing GitHub or GitLab connection in the sidebar.</p>
            {(githubConnected || gitlabConnected) && <div className="onboarding-connected">Connected: {[githubConnected && "GitHub", gitlabConnected && "GitLab"].filter(Boolean).join(" · ")}</div>}
            <form className="onboarding-form" onSubmit={clone}>
              <label>Repository URL
                <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/you/project.git" autoFocus required />
              </label>
              <label>Branch <span>optional</span>
                <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
              </label>
              {error && <p className="onboarding-error" role="alert">{error}</p>}
              <button className="onboarding-primary" disabled={cloning || !repoUrl.trim()}>{cloning ? "Creating workspace…" : "Clone and create a session"}</button>
            </form>
            <p className="onboarding-note">The clone continues safely in the background. A new session opens as soon as the workspace is created.</p>
          </>
        )}

        {step === 3 && (
          <>
            <h1 id="onboarding-title">Your first session is ready</h1>
            <p className="onboarding-intro">Describe the outcome, not the implementation. Waynode will inspect the repository and show its work as it goes.</p>
            <div className="onboarding-prompt">“Understand this codebase, then fix the most important issue you find.”</div>
            <p className="onboarding-note">Your new session is open now—paste that prompt, or start with your own task.</p>
          </>
        )}
      </section>
    </main>
  );
}
