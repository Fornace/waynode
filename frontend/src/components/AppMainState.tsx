import type { Org } from "../types";
import { OnboardingWizard } from "./OnboardingWizard";
import { StateSurface } from "./StateSurface";

interface AppMainStateProps {
  spacesCount: number;
  spacesLoading: boolean;
  workspaceError: string;
  activeOrgId: string | null;
  activeOrg?: Org;
  sidebarOpen: boolean;
  githubConnected: boolean;
  gitlabConnected: boolean;
  cloning: boolean;
  onboardingError: string;
  onToggleSidebar: () => void;
  onClone: (repoUrl: string, branch: string) => Promise<void>;
  onRetry: () => void;
}

export function AppMainState(props: AppMainStateProps) {
  if (props.spacesLoading) return <StateSurface title="Loading worktrees" description="Checking this organization for cloned repositories." busy />;
  if (props.workspaceError && props.spacesCount === 0) return <StateSurface
    title={props.activeOrgId ? "Couldn’t load worktrees" : "Couldn’t load organizations"}
    description={`${props.workspaceError} Existing worktrees and sessions were not changed.`}
    tone="error"
    action={{ label: "Try again", onClick: props.onRetry }}
  />;
  if (props.spacesCount === 0 && props.activeOrgId) return <OnboardingWizard
    githubConnected={props.githubConnected}
    gitlabConnected={props.gitlabConnected}
    cloning={props.cloning}
    error={props.onboardingError}
    onClone={props.onClone}
  />;
  if (!props.activeOrg) return <StateSurface
    title="No organization selected"
    description="Create or select an organization from the Worktrees menu to continue."
    action={!props.sidebarOpen ? { label: "Open Worktrees", onClick: props.onToggleSidebar } : undefined}
  />;
  return <StateSurface
    title="Choose a session"
    description={`Open a session in ${props.activeOrg.name}, or create one under a worktree.`}
    action={!props.sidebarOpen ? { label: "Open Worktrees", onClick: props.onToggleSidebar } : undefined}
  />;
}
