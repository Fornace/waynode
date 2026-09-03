/** Regression for npm 11 and npm 12 `npm pack --json` metadata. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiPackArtifact } from "../scripts/resolve-pi-pack.mjs";

const root = mkdtempSync(join(tmpdir(), "waynode-pi-pack-"));
const filename = "earendil-works-pi-coding-agent-0.84.4.tgz";
const packed = {
  name: "@earendil-works/pi-coding-agent",
  version: "0.84.4",
  integrity: "sha512-reviewed",
  filename,
};
const manifest = {
  pi: {
    package: packed.name,
    version: packed.version,
    integrity: packed.integrity,
  },
};

try {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, filename), "artifact");
  for (const [name, metadata] of [
    ["npm 11 array", [packed]],
    ["npm 12 keyed object", { [packed.name]: packed }],
  ]) {
    assert.equal(resolvePiPackArtifact({ manifest, metadata, packDir: root }), join(root, filename), name);
  }

  assert.throws(
    () => resolvePiPackArtifact({ manifest, metadata: [], packDir: root }),
    /exactly one packed Pi artifact/,
  );
  assert.throws(
    () => resolvePiPackArtifact({ manifest, metadata: { one: packed, two: packed }, packDir: root }),
    /exactly one packed Pi artifact/,
  );
  assert.throws(
    () => resolvePiPackArtifact({ manifest, metadata: [{ ...packed, version: "0.84.3" }], packDir: root }),
    /identity mismatch/,
  );
  assert.throws(
    () => resolvePiPackArtifact({ manifest, metadata: [{ ...packed, integrity: "sha512-other" }], packDir: root }),
    /integrity mismatch/,
  );
  assert.throws(
    () => resolvePiPackArtifact({ manifest, metadata: [{ ...packed, filename: "../escape.tgz" }], packDir: root }),
    /filename is invalid/,
  );
  assert.throws(
    () => resolvePiPackArtifact({ manifest, metadata: [{ ...packed, filename: "missing.tgz" }], packDir: root }),
    /artifact is missing/,
  );

  console.log("Pi pack metadata: npm 11 and npm 12 shapes accepted safely");
} finally {
  rmSync(root, { recursive: true, force: true });
}
