import assert from "node:assert/strict";
import { createGitHubRepository, createGitLabRepository } from "../lib/provider-repositories.mjs";

let request;
const github = await createGitHubRepository("secret", {
  name: "new-repo",
  description: "Created in Waynode",
  visibility: "private",
}, async (url, options) => {
  request = { url, options, body: JSON.parse(options.body) };
  return new Response(JSON.stringify({
    id: 1, name: "new-repo", full_name: "me/new-repo", clone_url: "https://github.com/me/new-repo.git",
    html_url: "https://github.com/me/new-repo", default_branch: "main", private: true,
  }), { status: 201, headers: { "Content-Type": "application/json" } });
});
assert.equal(request.url, "https://api.github.com/user/repos");
assert.deepEqual(request.body, { name: "new-repo", description: "Created in Waynode", private: true, auto_init: true });
assert.equal(request.options.headers.Authorization, "Bearer secret");
assert.equal(github.url, "https://github.com/me/new-repo.git");
assert.equal(github.private, true);

const gitlab = await createGitLabRepository("secret", {
  name: "new-project",
  visibility: "public",
}, "https://gitlab.example", async (url, options) => {
  request = { url, options, body: JSON.parse(options.body) };
  return new Response(JSON.stringify({
    id: 2, name: "new-project", path_with_namespace: "me/new-project", http_url_to_repo: "https://gitlab.example/me/new-project.git",
    web_url: "https://gitlab.example/me/new-project", default_branch: "main", visibility: "public",
  }), { status: 201, headers: { "Content-Type": "application/json" } });
});
assert.equal(request.url, "https://gitlab.example/api/v4/projects");
assert.deepEqual(request.body, { name: "new-project", description: "", visibility: "public", initialize_with_readme: true });
assert.equal(gitlab.private, false);

await assert.rejects(() => createGitHubRepository("secret", { name: "" }, fetch), /name is required/);
await assert.rejects(
  () => createGitHubRepository("secret", { name: "taken" }, async () => new Response(JSON.stringify({ message: "name already exists" }), { status: 422, headers: { "Content-Type": "application/json" } })),
  (error) => error.status === 422 && /name already exists/.test(error.message),
);

console.log("provider repository creation: GitHub, GitLab, validation, and provider errors passed");
