#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Must match the key and endpoint embedded by the updater-enabled release build (#312).
const publicKeyBase64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJDQjQ2RDZFMUEwOERFMTEKUldRUjNnZ2FibTIwTE10QkVaMzFyYkZlY0R4ajhmbFBjdncvNVRCYnNpSm9kaFNBaHQzemZlZHkK";
const endpoint =
  "https://github.com/block/buzz-app/releases/download/preview-feed/latest.json";
const [command, version, signaturePath, manifestPath] = process.argv.slice(2);
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const release = `v${version}`;
const archive = `Buzz_${version}_aarch64.app.tar.gz`;
const url = `https://github.com/block/buzz-app/releases/download/${release}/${archive}`;

function previewNumber(value) {
  const match = versionPattern.exec(value);
  assert.ok(match, `Invalid preview version: ${value}`);
  return match.slice(1).map(BigInt);
}

function compareVersions(left, right) {
  const a = previewNumber(left);
  const b = previewNumber(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function decodeBase64(value) {
  assert.match(
    value,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  );
  return Buffer.from(value, "base64");
}

function verifyArtifact(archivePath, binaryPath) {
  const keyLines = decodeBase64(publicKeyBase64)
    .toString("utf8")
    .trimEnd()
    .split("\n");
  assert.equal(keyLines.length, 2);
  const keyRecord = decodeBase64(keyLines[1]);
  assert.equal(keyRecord.length, 42);
  assert.equal(keyRecord.subarray(0, 2).toString(), "Ed");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      keyRecord.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });

  const signedText = decodeBase64(
    readFileSync(signaturePath, "utf8").trim(),
  ).toString("utf8");
  const lines = signedText.trimEnd().split("\n");
  assert.equal(lines.length, 4, "Expected a complete Minisign signature");
  assert.match(lines[0], /^untrusted comment: /);
  assert.match(lines[2], /^trusted comment: /);
  const record = decodeBase64(lines[1]);
  const global = decodeBase64(lines[3]);
  assert.equal(record.length, 74);
  assert.equal(global.length, 64);
  assert.deepEqual(
    record.subarray(2, 10),
    keyRecord.subarray(2, 10),
    "Signing key mismatch",
  );
  const message = readFileSync(archivePath);
  const algorithm = record.subarray(0, 2).toString();
  assert.ok(
    algorithm === "ED" || algorithm === "Ed",
    "Unsupported signature algorithm",
  );
  const payload =
    algorithm === "ED"
      ? createHash("blake2b512").update(message).digest()
      : message;
  assert.ok(
    verifyEd25519(null, payload, key, record.subarray(10)),
    "Archive signature invalid",
  );
  const trusted = lines[2].slice("trusted comment: ".length);
  assert.ok(
    verifyEd25519(
      null,
      Buffer.concat([record.subarray(10), Buffer.from(trusted)]),
      key,
      global,
    ),
    "Trusted comment signature invalid",
  );
  // CLI 2.11.x signs the trusted comment but does not include a version field.
  // Require version binding when the signer and client move to 2.12.x together.

  const binary = readFileSync(binaryPath);
  assert.ok(
    binary.includes(Buffer.from(endpoint)),
    "Candidate does not embed the updater endpoint",
  );
  assert.ok(
    binary.includes(Buffer.from(publicKeyBase64)),
    "Candidate does not embed the updater public key",
  );
}

function signature(path) {
  return readFileSync(path, "utf8").trim();
}

function validate(manifest, expectedSignature) {
  assert.equal(manifest.version, version);
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64"]);
  assert.deepEqual(manifest.platforms["darwin-aarch64"], {
    signature: expectedSignature,
    url,
  });
}

previewNumber(version);
if (command !== "generate" && command !== "verify") {
  throw new Error(
    "Usage: preview-feed.mjs generate|verify <version> <signature-file> <manifest-file> <archive-file> <app-binary-file> [current-manifest-file]",
  );
}
const archivePath = process.argv[6];
const binaryPath = process.argv[7];
assert.ok(archivePath && binaryPath, "Archive and app binary are required");
verifyArtifact(archivePath, binaryPath);
const expectedSignature = signature(signaturePath);
if (command === "generate") {
  const currentPath = process.argv[8];
  if (currentPath) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    if (current.version === version) {
      validate(current, expectedSignature);
      writeFileSync(manifestPath, readFileSync(currentPath, "utf8"));
      process.exit(0);
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version,
        notes: `Buzz ${version} macOS preview`,
        pub_date: new Date().toISOString(),
        platforms: { "darwin-aarch64": { signature: expectedSignature, url } },
      },
      null,
      2,
    )}\n`,
  );
} else if (command === "verify") {
  validate(JSON.parse(readFileSync(manifestPath, "utf8")), expectedSignature);
  const currentPath = process.argv[8];
  if (currentPath) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    const order = compareVersions(version, current.version);
    assert.ok(order >= 0, "Refusing preview feed rollback");
    if (order === 0) {
      assert.equal(
        readFileSync(manifestPath, "utf8"),
        readFileSync(currentPath, "utf8"),
        "Same-version manifest differs",
      );
    }
  }
} else {
  throw new Error(
    "Usage: preview-feed.mjs generate|verify <version> <signature-file> <manifest-file> [current-manifest-file]",
  );
}
