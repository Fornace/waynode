import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { config } from "../lib/config.mjs";
import db from "../lib/db.mjs";
import { oauthConnectionStatus, oauthTokenForUser } from "../lib/oauth-tokens.mjs";

const router = Router();

router.get("/api/repos/github", requireAuth, async (req, res) => {
  const token = oauthTokenForUser(db, req.user.id, "github");
  if (!token) {
    return res.json({ connected: false, groups: [] });
  }

  try {
    const resp = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Waynode-AI",
      },
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `GitHub API: ${resp.statusText}` });
    }

    const repos = await resp.json();
    const groups = {};

    for (const repo of repos) {
      const owner = repo.owner.login;
      if (!groups[owner]) {
        groups[owner] = {
          owner,
          avatar: repo.owner.avatar_url,
          url: repo.owner.html_url,
          repos: [],
        };
      }
      groups[owner].repos.push({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        url: repo.clone_url,
        ssh_url: repo.ssh_url,
        private: repo.private,
        fork: repo.fork,
        default_branch: repo.default_branch,
        description: repo.description,
        stars: repo.stargazers_count,
        updated_at: repo.updated_at,
        language: repo.language,
        html_url: repo.html_url,
      });
    }

    const result = Object.values(groups).sort((a, b) => {
      if (a.owner === req.user.name) return -1;
      if (b.owner === req.user.name) return 1;
      return a.owner.localeCompare(b.owner);
    });

    res.json({ connected: true, groups: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/repos/gitlab", requireAuth, async (req, res) => {
  const token = oauthTokenForUser(db, req.user.id, "gitlab");
  if (!token) {
    return res.json({ connected: false, groups: [] });
  }

  try {
    const baseUrl = config.gitlab.baseUrl;
    const resp = await fetch(`${baseUrl}/api/v4/projects?membership=true&per_page=100&order_by=updated_at`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `GitLab API: ${resp.statusText}` });
    }

    const projects = await resp.json();
    const groups = {};

    for (const proj of projects) {
      const ns = proj.namespace?.name || "Personal";
      if (!groups[ns]) {
        groups[ns] = {
          owner: ns,
          avatar: proj.namespace?.avatar_url || proj.avatar_url || null,
          url: proj.namespace?.web_url || baseUrl,
          repos: [],
        };
      }
      groups[ns].repos.push({
        id: proj.id,
        name: proj.name,
        full_name: proj.path_with_namespace,
        url: proj.http_url_to_repo,
        ssh_url: proj.ssh_url_to_repo,
        private: proj.visibility === "private",
        fork: false,
        default_branch: proj.default_branch,
        description: proj.description,
        stars: proj.star_count,
        updated_at: proj.last_activity_at,
        language: null,
        html_url: proj.web_url,
      });
    }

    res.json({ connected: true, groups: Object.values(groups) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/repos/status", requireAuth, (req, res) => {
  res.json(oauthConnectionStatus(db, req.user.id));
});

export default router;
