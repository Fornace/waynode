/** SSRF regression for hosted repository clone URL policy. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-clone-policy-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "clone-policy-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.GITLAB_BASE_URL = "https://git.corp.example/platform";

const { assertSafeRepoUrl } = await import("../lib/spaces.mjs");

try {
  for (const url of [
    "https://github.com/example/repo.git",
    "https://git.corp.example/group/repo.git",
  ]) assert.equal(assertSafeRepoUrl(url), url);

  for (const url of [
    "http://github.com/example/repo.git",
    "git://github.com/example/repo.git",
    "ssh://git@github.com/example/repo.git",
    "git@github.com:example/repo.git",
    "https://github.com:444/example/repo.git",
    "https://github.com.evil.example/example/repo.git",
    "https://gitlab.com/example/repo.git",
    "https://git.corp.example.evil.test/group/repo.git",
    "https://localhost/repo.git",
    "https://127.0.0.1/repo.git",
    "https://[::1]/repo.git",
    "https://2130706433/repo.git",
    "https://0x7f000001/repo.git",
    "https://github.com@127.0.0.1/repo.git",
    "file:///etc/passwd",
    "ext::sh -c id",
  ]) assert.throws(() => assertSafeRepoUrl(url), undefined, `hosted clone must reject ${url}`);

  for (const url of [
    "http://git.internal.test/repo.git",
    "ssh://git@git.internal.test/repo.git",
    "git@git.internal.test:group/repo.git",
  ]) assert.equal(assertSafeRepoUrl(url, { deployment: "self-hosted" }), url);
  assert.throws(() => assertSafeRepoUrl("file:///etc/passwd", { deployment: "self-hosted" }));
  assert.throws(() => assertSafeRepoUrl("ext::sh -c id", { deployment: "self-hosted" }));
  console.log("hosted clone URL policy regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
