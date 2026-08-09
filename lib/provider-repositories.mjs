const VISIBILITIES = new Set(["private", "public"]);

function cleanInput(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const visibility = VISIBILITIES.has(input.visibility) ? input.visibility : "private";
  if (!name) throw Object.assign(new Error("Repository name is required"), { status: 400 });
  if (name.length > 100) throw Object.assign(new Error("Repository name must be 100 characters or fewer"), { status: 400 });
  if (description.length > 350) throw Object.assign(new Error("Description must be 350 characters or fewer"), { status: 400 });
  return { name, description, visibility };
}

async function providerResponse(response, provider) {
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body;
  const detail = body.message || body.error_description || body.error || response.statusText;
  const error = new Error(`${provider} could not create the repository${detail ? `: ${detail}` : ""}`);
  error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
  throw error;
}

export async function createGitHubRepository(token, input, request = fetch) {
  const { name, description, visibility } = cleanInput(input);
  const response = await request("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Waynode-AI",
    },
    body: JSON.stringify({ name, description, private: visibility === "private", auto_init: true }),
  });
  const repo = await providerResponse(response, "GitHub");
  return {
    provider: "github",
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    url: repo.clone_url,
    html_url: repo.html_url,
    default_branch: repo.default_branch || "main",
    private: Boolean(repo.private),
  };
}

export async function createGitLabRepository(token, input, baseUrl, request = fetch) {
  const { name, description, visibility } = cleanInput(input);
  const response = await request(`${baseUrl}/api/v4/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description, visibility, initialize_with_readme: true }),
  });
  const repo = await providerResponse(response, "GitLab");
  return {
    provider: "gitlab",
    id: repo.id,
    name: repo.name,
    full_name: repo.path_with_namespace,
    url: repo.http_url_to_repo,
    html_url: repo.web_url,
    default_branch: repo.default_branch || "main",
    private: repo.visibility === "private",
  };
}
