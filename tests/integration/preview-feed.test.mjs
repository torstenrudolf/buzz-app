import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
  generateKeyPairSync,
  sign as signEd25519,
  createHash,
} from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";

const script = new URL("../../scripts/preview-feed.mjs", import.meta.url)
  .pathname;

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

const endpoint =
  "https://github.com/block/buzz-app/releases/download/preview-feed/latest.json";
const publicKeyBase64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJDQjQ2RDZFMUEwOERFMTEKUldRUjNnZ2FibTIwTE10QkVaMzFyYkZlY0R4ajhmbFBjdncvNVRCYnNpSm9kaFNBaHQzemZlZHkK";
// Inject a disposable public key into a copy of the promotion script, never into production.
function fixture(dir, version = "0.0.0-preview.22.1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("12345678");
  const keyRecord = Buffer.concat([
    Buffer.from("Ed"),
    keyId,
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ]);
  const encodedKey = Buffer.from(
    `untrusted comment: test public key\n${keyRecord.toString("base64")}\n`,
  ).toString("base64");
  const localScript = join(dir, "preview-feed.mjs");
  writeFileSync(
    localScript,
    readFileSync(script, "utf8").replace(publicKeyBase64, encodedKey),
  );
  const archive = join(dir, "archive.tar.gz");
  const binary = join(dir, "buzz-foundation");
  const sig = join(dir, "archive.sig");
  const manifest = join(dir, "manifest.json");
  writeFileSync(archive, "fixture archive bytes");
  writeFileSync(binary, `compiled: ${endpoint} ${encodedKey}`);
  function sign(versionField = "", signingKey = privateKey) {
    const record = Buffer.concat([
      Buffer.from("ED"),
      keyId,
      signEd25519(
        null,
        createHash("blake2b512").update(readFileSync(archive)).digest(),
        signingKey,
      ),
    ]);
    const comment = `timestamp:1\tfile:archive.tar.gz${versionField ? `\tversion:${versionField}` : ""}`;
    const global = signEd25519(
      null,
      Buffer.concat([record.subarray(10), Buffer.from(comment)]),
      signingKey,
    );
    const text = `untrusted comment: test signature\n${record.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
    writeFileSync(sig, `${Buffer.from(text).toString("base64")}\n`);
  }
  sign();
  const args = (action, current) => [
    localScript,
    action,
    version,
    sig,
    manifest,
    archive,
    binary,
    ...(current ? [current] : []),
  ];
  const execute = (action, current) =>
    spawnSync(process.execPath, args(action, current), { encoding: "utf8" });
  return { archive, binary, sig, manifest, sign, execute };
}

test("preview candidate requires verified archive and updater-enabled binary with CLI 2.11.x signatures", () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-feed-"));
  const { archive, binary, sig, manifest, sign, execute } = fixture(dir);
  const validSignature = readFileSync(sig, "utf8").trim();
  assert.equal(execute("generate").status, 0);
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.platforms["darwin-aarch64"].signature, validSignature);
  assert.equal(
    data.platforms["darwin-aarch64"].url,
    "https://github.com/block/buzz-app/releases/download/v0.0.0-preview.22.1/Buzz_0.0.0-preview.22.1_aarch64.app.tar.gz",
  );
  assert.equal(execute("verify").status, 0);
  const older = join(dir, "older.json");
  writeFileSync(
    older,
    JSON.stringify({ ...data, version: "0.0.0-preview.23.1" }),
  );
  assert.match(execute("verify", older).stderr, /rollback/);
  writeFileSync(
    older,
    JSON.stringify({ ...data, version: "0.0.0-preview.22.1" }),
  );
  assert.match(execute("verify", older).stderr, /differs/);
  data.platforms["darwin-aarch64"].url = "https://example.com/wrong";
  writeFileSync(manifest, JSON.stringify(data));
  assert.notEqual(execute("verify").status, 0);
  assert.notEqual(
    run("generate", "0.0.0-preview.bad", sig, manifest, archive, binary).status,
    0,
  );
  writeFileSync(archive, "tampered archive");
  assert.match(execute("verify").stderr, /Archive signature invalid/);
  writeFileSync(archive, "fixture archive bytes");
  const otherKey = generateKeyPairSync("ed25519").privateKey;
  sign(undefined, otherKey);
  assert.match(execute("verify").stderr, /Archive signature invalid/);
  // A signed archive can be replayed under another advertised version until
  // the signer and updater both enforce version binding in 2.12.x.
  sign("99.0.0-preview.999.1");
  assert.equal(execute("generate").status, 0);
  sign();
  const modifiedComment = Buffer.from(
    readFileSync(sig, "utf8").trim(),
    "base64",
  )
    .toString("utf8")
    .replace("trusted comment: timestamp:1", "trusted comment: timestamp:2");
  writeFileSync(sig, `${Buffer.from(modifiedComment).toString("base64")}\n`);
  assert.match(execute("verify").stderr, /Trusted comment signature invalid/);
  sign();
  writeFileSync(sig, "YWJjZA==\n");
  assert.notEqual(execute("verify").status, 0);
  sign();
  writeFileSync(binary, `compiled: ${endpoint}`);
  assert.match(execute("verify").stderr, /updater public key/);
});

test("preview rollback compares the complete canonical SemVer without number rounding", () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-versions-"));
  const { manifest, execute } = fixture(dir);
  assert.equal(execute("generate").status, 0);
  const current = join(dir, "current.json");
  const candidate = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(
    current,
    JSON.stringify({ ...candidate, version: "1.0.0-preview.21.1" }),
  );
  assert.match(execute("verify", current).stderr, /rollback/);
  writeFileSync(
    current,
    JSON.stringify({ ...candidate, version: "0.0.0-preview.23.1" }),
  );
  assert.match(execute("verify", current).stderr, /rollback/);
  for (const invalid of [
    "01.0.0-preview.22.1",
    "0.0.0-preview.022.1",
    "0.0.0-preview.bad",
  ]) {
    writeFileSync(current, JSON.stringify({ ...candidate, version: invalid }));
    assert.match(execute("verify", current).stderr, /Invalid preview version/);
  }
});

test("successful preview publication promotes automatically; manual recovery bypasses skipped builds", () => {
  const workflow = parse(
    readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  );
  const { build, publish, promote_preview: promotion } = workflow.jobs;
  assert.match(build.if, /!inputs\.promote_version/);
  assert.equal(publish.needs, "build");
  assert.deepEqual(promotion.needs, ["build", "publish"]);
  assert.match(promotion.if, /!cancelled\(\)/);
  assert.match(promotion.if, /!inputs\.candidates/);
  assert.match(
    promotion.if,
    /inputs\.promote_version == '' && needs\.build\.result == 'success' && needs\.publish\.result == 'success'/,
  );
  assert.match(
    promotion.if,
    /inputs\.promote_version != '' && needs\.build\.result == 'skipped' && needs\.publish\.result == 'skipped'/,
  );
  assert.equal(promotion.permissions.contents, "write");
  const promotionStep = promotion.steps.find((step) =>
    step.run?.includes("scripts/preview-feed.mjs verify"),
  );
  assert.equal(
    promotionStep.env.VERSION,
    `\${{ inputs.promote_version || needs.build.outputs.version }}`,
  );
  assert.ok(
    promotionStep.run.indexOf("scripts/preview-feed.mjs verify") <
      promotionStep.run.indexOf("gh release upload preview-feed"),
  );
});
