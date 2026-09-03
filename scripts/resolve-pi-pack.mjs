#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export function resolvePiPackArtifact({ manifest, metadata, packDir }) {
  const entries = Array.isArray(metadata)
    ? metadata
    : metadata && typeof metadata === "object"
      ? Object.values(metadata)
      : [];
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== "object") {
    throw new Error("Expected exactly one packed Pi artifact");
  }

  const packed = entries[0];
  if (packed.name !== manifest.pi.package || packed.version !== manifest.pi.version) {
    throw new Error("Packed Pi identity mismatch");
  }
  if (packed.integrity !== manifest.pi.integrity) {
    throw new Error("Packed Pi integrity mismatch");
  }
  if (!packed.filename || basename(packed.filename) !== packed.filename) {
    throw new Error("Packed Pi filename is invalid");
  }

  const artifact = join(packDir, packed.filename);
  if (!existsSync(artifact) || !statSync(artifact).isFile()) {
    throw new Error("Packed Pi artifact is missing");
  }
  return artifact;
}

function main([manifestPath, metadataPath, packDir]) {
  if (!manifestPath || !metadataPath || !packDir) {
    throw new Error("Usage: resolve-pi-pack.mjs <manifest> <pack-json> <pack-dir>");
  }
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  console.log(resolvePiPackArtifact({
    manifest: readJson(manifestPath),
    metadata: readJson(metadataPath),
    packDir,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
