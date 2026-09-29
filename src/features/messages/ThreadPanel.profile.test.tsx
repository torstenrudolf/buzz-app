// @vitest-environment jsdom
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, loadavg, release } from "node:os";
import { Session } from "node:inspector/promises";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { it, vi } from "vitest";
import { ThreadPanel } from "./ThreadPanel";
import {
  threadData,
  threadSample,
  workload,
} from "../relay/thread-profile-fixture";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";

// Isolate thread acquisition from composer emoji demand and DOM reading dwell.
// Actual React effects, ThreadPanel, MessageRow, session and HTTP verification run.
// jsdom observes DOM commit, NOT browser layout/paint or native interaction.
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
vi.mock("./use-reading", () => ({ useReading: () => {} }));

function mount(session: RelaySession, channelId: string, messageId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let view: ThreadView | undefined;
  // Forward every capability unchanged, intercepting allocation only to observe it.
  const observed: RelaySession = {
    ...session,
    thread(...args) {
      view = session.thread(...args);
      return view;
    },
  };
  flushSync(() =>
    root.render(
      <ThreadPanel
        session={observed}
        scope="profile"
        channelName="A"
        channelId={channelId}
        messageId={messageId}
        close={() => {}}
        onOpenLink={() => false}
      />,
    ),
  );
  assert.ok(view, "real panel must allocate its own thread");
  const owned = view;
  return {
    view: owned,
    async rendered() {
      const ready = () => {
        const rows = container.querySelectorAll("[data-message-id]");
        const expected = [owned.snapshot().root, ...owned.snapshot().replies];
        if (rows.length !== expected.length) return false;
        if (
          !expected.every(
            (row, i) =>
              row && rows[i]?.getAttribute("data-message-id") === row.id,
          )
        )
          return false;
        return container.textContent?.includes("Author 7") === true;
      };
      if (ready()) return;
      await new Promise<void>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (ready()) {
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Thread DOM did not settle"));
        }, 10_000);
        observer.observe(container, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
    },
    dispose() {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function provenance() {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const paths = [
    ...new Set(
      git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
        .split("\0")
        .filter(
          (p) => /\.(ts|tsx|mjs|js|json|yaml|yml)$/.test(p) && existsSync(p),
        ),
    ),
  ].sort();
  const hashes = Object.fromEntries(
    paths.map((p) => [p, hash(readFileSync(p))]),
  );
  return {
    head: git("rev-parse", "HEAD"),
    fingerprint: hash(JSON.stringify(hashes)),
    hashes,
  };
}

it("profiles the unchanged mounted app thread over signed HTTP, cold then reopen", async () => {
  const output = process.env.BUZZ_ENGINE_PROFILE_OUT;
  const count = output
    ? Number(process.env.BUZZ_ENGINE_PROFILE_SAMPLES ?? 7)
    : 1;
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 50);
  if (output) assert.ok(!existsSync(output), "choose a new output path");
  const source = output ? provenance() : undefined;
  const initialLoad = output ? loadavg() : undefined;
  const data = threadData(); // signatures are setup, outside the timed work
  const warmups = output ? 2 : 0;
  for (let i = 0; i < warmups; i++) await threadSample(data, mount);
  const profiler = process.env.BUZZ_ENGINE_CPU_OUT ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.start");
  }
  const samples = [];
  try {
    for (let i = 0; i < count; i++)
      samples.push(await threadSample(data, mount));
  } finally {
    if (profiler) {
      const { profile } = await profiler.post("Profiler.stop");
      writeFileSync(
        process.env.BUZZ_ENGINE_CPU_OUT as string,
        JSON.stringify(profile),
        { flag: "wx" },
      );
      profiler.disconnect();
    }
  }
  if (!output || !source) return;
  assert.deepEqual(provenance(), source, "source changed during measurement");
  const artifact = {
    schema: 1,
    workload,
    source,
    compatibility: {
      fixtureHash: data.hash,
      harnessHash: hash(
        readFileSync("src/features/relay/thread-profile-fixture.ts", "utf8") +
          readFileSync(
            "src/features/messages/ThreadPanel.profile.test.tsx",
            "utf8",
          ),
      ),
      lockHash: hash(readFileSync("pnpm-lock.yaml")),
      node: process.version,
      v8: process.versions.v8,
      os: release(),
      host: hostname(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      profiled: !!profiler,
    },
    capturedAt: new Date().toISOString(),
    initialLoad,
    finalLoad: loadavg(),
    warmups,
    samples,
  };
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      output,
      head: source.head,
      fingerprint: source.fingerprint,
      samples: count,
    }),
  );
}, 120_000);
