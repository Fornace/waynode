import { useState, type FormEvent } from "react";

interface OnboardingWizardProps {
  githubConnected: boolean;
  gitlabConnected: boolean;
  cloning: boolean;
  error?: string;
  onClone: (repoUrl: string, branch: string) => Promise<void>;
}

export function OnboardingWizard({ githubConnected, gitlabConnected, cloning, error, onClone }: OnboardingWizardProps) {
  const [complete, setComplete] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const connected = [githubConnected && "GitHub", gitlabConnected && "GitLab"].filter(Boolean);

  const clone = async (event: FormEvent) => {
    event.preventDefault();
    if (!repoUrl.trim() || cloning) return;
    try {
      await onClone(repoUrl.trim(), branch.trim() || "main");
      setComplete(true);
    } catch {
      // The parent keeps this form and its values in place with the server's
      // actionable error. A failed clone never masquerades as completion.
    }
  };

  return (
    <main className="onboarding" aria-labelledby="onboarding-title">
      <section className="onboarding-card">
        <div className="onboarding-kicker">First worktree</div>
        <div className="onboarding-progress" aria-label={complete ? "Step 2 of 2" : "Step 1 of 2"}>
          <span className="complete" /><span className={complete ? "complete" : ""} />
        </div>

        {!complete ? <>
          <h1 id="onboarding-title">Bring in a repository</h1>
          <p className="onboarding-intro">Clone a Git repository into this server. Waynode keeps its branch, sessions, and changed files together as one durable worktree.</p>
          {connected.length > 0 && <div className="onboarding-connected">Connected: {connected.join(" · ")}</div>}
          <form className="onboarding-form" onSubmit={clone}>
            <label>Repository URL
              <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/you/project.git" autoFocus required />
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
