import { useState } from "react";
import { api } from "../api/client";
import type { GitSnapshot, Session } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

type LifecycleAction = "archive" | "delete";

interface PendingLifecycle {
  session: Session;
  action: LifecycleAction;
  commitFirst: boolean;
  snapshot: GitSnapshot | null;
}

interface SessionLifecycleOptions {
  onArchived: (session: Session) => void;
  onDeleted: (sessionId: string) => void;
  onRefreshGit: (spaceId: string) => void;
  onRefreshArchived: (spaceId: string) => void;
  onIssue: (message: string, retry?: () => void) => void;
}

export function useSessionLifecycle(options: SessionLifecycleOptions) {
  const [pending, setPending] = useState<PendingLifecycle | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const archiveSession = async (session: Session, archived: boolean) => {
    setBusySessionId(session.id);
    try {
      const updated = await api.sessions.archive(session.id, archived);
      options.onArchived(updated);
      options.onRefreshArchived(session.space_id);
    } catch (error) {
      options.onIssue((error as Error).message, () => archiveSession(session, archived));
    } finally {
      setBusySessionId(null);
    }
  };

  const commitCurrentChanges = async (session: Session) => {
    const snapshot = await api.git.status(session.space_id);
    if (!snapshot.hasUncommittedChanges || snapshot.files.length === 0) return;
    await api.git.commit(session.space_id, {
      files: snapshot.files.map((file) => file.path),
      summary: commitSummary(session),
    });
    options.onRefreshGit(session.space_id);
  };

  const runLifecycle = async (request: PendingLifecycle) => {
    const { session, action, commitFirst } = request;
    setPending(null);
    setBusySessionId(session.id);
    try {
      if (commitFirst) await commitCurrentChanges(session);
      if (action === "archive") {
        const updated = await api.sessions.archive(session.id, true);
        options.onArchived(updated);
        options.onRefreshArchived(session.space_id);
      } else {
        await api.sessions.delete(session.id);
        options.onDeleted(session.id);
      }
    } catch (error) {
      const protectedAction = action === "archive" ? "archived" : "deleted";
      const prefix = commitFirst
        ? `The commit failed, so the session was not ${protectedAction}.`
        : `The session was not ${protectedAction}.`;
      options.onIssue(`${prefix} ${(error as Error).message}`, () => runLifecycle(request));
    } finally {
      setBusySessionId(null);
    }
  };

  const requestLifecycle = async (session: Session, action: LifecycleAction, commitFirst: boolean) => {
    setBusySessionId(session.id);
    try {
      const snapshot = commitFirst ? await api.git.status(session.space_id) : null;
      setPending({ session, action, commitFirst, snapshot });
    } catch (error) {
      options.onIssue(
        `Waynode couldn’t inspect the worktree, so no commit or session action was performed. ${(error as Error).message}`,
        () => requestLifecycle(session, action, commitFirst),
      );
    } finally {
      setBusySessionId(null);
    }
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={dialogTitle(pending)}
      description={dialogDescription(pending)}
      confirmLabel={confirmLabel(pending)}
      danger={pending.action === "delete"}
      onCancel={() => setPending(null)}
      onConfirm={() => runLifecycle(pending)}
    />
  ) : null;

  return { archiveSession, busySessionId, dialog, requestLifecycle };
}

function commitSummary(session: Session) {
  return `Auto-commit before closing session: ${session.title}`;
}

function dialogTitle(request: PendingLifecycle) {
  if (request.commitFirst) return request.action === "archive"
    ? "Commit worktree changes and archive?"
    : "Commit worktree changes and delete session?";
  return `Delete “${request.session.title}”?`;
}

function confirmLabel(request: PendingLifecycle) {
  if (request.commitFirst) return request.action === "archive" ? "Commit & archive" : "Commit & delete";
  return "Delete session";
}

function dialogDescription(request: PendingLifecycle) {
  const { session, action, commitFirst, snapshot } = request;
  const outcome = action === "archive"
    ? `The session “${session.title}” will move to Archived and can be restored later.`
    : `The session “${session.title}” and its conversation history will be permanently deleted.`;
  if (!commitFirst || !snapshot) {
    return `${outcome} The worktree, its branch, commits, and files remain exactly as they are. This cannot be undone.`;
  }
  const count = snapshot.files.length;
  const branch = snapshot.currentBranch || "the current detached revision";
  const commit = count > 0
    ? `${count} currently changed file${count === 1 ? "" : "s"} on ${branch} will be committed with the summary “${commitSummary(session)}”.`
    : `The worktree on ${branch} is currently clean, so no commit will be created.`;
  const permanence = action === "delete" ? " Deleting the session cannot be undone." : "";
  return `${commit} ${outcome} The worktree, branch, files, and resulting commit remain.${permanence}`;
}
