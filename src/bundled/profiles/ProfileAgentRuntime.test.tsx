// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { keypair, signed } from "../../features/relay/testing";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentControl,
  type AgentControlHost,
  type ControlSnapshot,
} from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import type { LiveCallbacks } from "../../features/relay/live";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";
import { ProfileHarnessLog } from "./ProfileHarnessLog";

const agent = keypair();
const agentKey = agent.pubkey;
const signer = keypair();
const viewer = signer.pubkey;
const home = `https://relay.example.test:${viewer}`;
const elsewhere = `https://other.example.test:${viewer}`;
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

function relayAt(scope: string, knownAgent = false, owned = true) {
  const attestor = owned ? signer : keypair();
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agentKey}:`)
    .digest();
  const head = signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Fixture agent", is_agent: true }),
    tags: [
      [
        "auth",
        attestor.pubkey,
        "",
        bytesToHex(schnorr.sign(new Uint8Array(digest), attestor.secret)),
      ],
    ],
  });
  let latest = head;
  let callbacks!: LiveCallbacks;
  let failOwner = false;
  let ownerReadStarted = () => {};
  let ownerGate = Promise.resolve();
  const owner = createRelaySession({
    viewer: signer.pubkey,
    relayAuthor: signer.pubkey,
    query: async (filters) => {
      if (!filters.some((filter) => filter.kinds?.includes(0))) return [];
      ownerReadStarted();
      await ownerGate;
      if (failOwner) throw new Error("Fixture ownership unavailable");
      return [latest];
    },
    media: () => undefined,
    subscribe(next) {
      callbacks = next;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const ownershipViews: ReturnType<typeof owner.session.observe>[] = [];
  const observedSession = {
    ...owner.session,
    observe: (...args: Parameters<typeof owner.session.observe>) => {
      const view = owner.session.observe(...args);
      ownershipViews.push(view);
      return view;
    },
  };
  const listeners = new Set<() => void>();
  // Signed agent metadata makes ProfileInstances a second native reader.
  const profiles = new Map([
    [agentKey, { name: "Fixture agent", isAgent: true }],
  ]);
  const session = knownAgent
    ? ({
        ...observedSession,
        profiles: { ...observedSession.profiles, snapshot: () => profiles },
      } as RelaySnapshot["session"])
    : observedSession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope,
    viewer,
    session: { ...session, authorizeAgentLog: async () => "fixture-signature" },
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  return {
    relay,
    holdOwnerRead() {
      const started = new Promise<void>((resolve) => {
        ownerReadStarted = resolve;
      });
      let releaseOwner = () => {};
      ownerGate = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      return { started, release: () => releaseOwner() };
    },
    refreshOwnership() {
      return Promise.all(ownershipViews.map((view) => view.refresh()));
    },
    failOwner(value: boolean) {
      failOwner = value;
    },
    move(next: string) {
      snapshot = {
        ...snapshot,
        scope: next,
        generation: snapshot.generation + 1,
      };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    async revokeOwner() {
      const unowned = keypair();
      const revokedHead = signed(agent, {
        kind: 0,
        created_at: head.created_at + 1,
        content: JSON.stringify({ name: "Fixture agent", is_agent: true }),
        tags: [
          [
            "auth",
            unowned.pubkey,
            "",
            bytesToHex(schnorr.sign(new Uint8Array(digest), unowned.secret)),
          ],
        ],
      });
      latest = revokedHead;
      await act(async () => {
        callbacks.receive([revokedHead]);
      });
    },
  };
}

/** Each read is held until the test settles it. */
function heldHost(
  fixture = controlFixture(),
  readLog?: AgentControlHost["readLog"],
) {
  fixture.agent.pubkey = agentKey;
  const reads: {
    resolve(data: ControlSnapshot): void;
    reject(error: unknown): void;
  }[] = [];
  const host: AgentControlHost = {
    ...fixture.host,
    ...(readLog ? { readLog } : {}),
    snapshot: () =>
      new Promise((resolve, reject) => reads.push({ resolve, reject })),
  };
  const control = createAgentControl(host);
  owners.push(control);
  /** Observe that read `index` started, then settle it inside act. */
  const settle = async (index: number, outcome: ControlSnapshot | string) => {
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(index));
    await act(async () => {
      const read = reads[index];
      if (typeof outcome === "string") read?.reject(outcome);
      else read?.resolve(structuredClone(outcome));
    });
  };
  return { control, reads, settle, data: fixture.data, agent: fixture.agent };
}

function mount(
  control: ReturnType<typeof createAgentControl>,
  relay: RelayData,
  pubkey = agentKey,
) {
  return render(
    <StrictMode>
      <ProfilePanel
        relay={relay}
        control={control}
        target={profileTarget(pubkey) ?? ""}
        close={() => {}}
      />
    </StrictMode>,
  );
}

it("keeps browser and unavailable-host profiles public, without an owner view", async () => {
  const control = createAgentControl(null);
  owners.push(control);
  mount(control, relayAt(home).relay);
  await screen.findByRole("region", { name: "Profile details" });
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
  expect(
    screen.getByRole("heading", { level: 3, name: "Public key" }),
  ).toBeVisible();
});

it("summarizes only the exact key in the active community, and drops it when the scope moves", async () => {
  const { control, settle, data, agent } = heldHost();
  Object.assign(agent, {
    relayUrl: "wss://relay.example.test",
    revision: 3,
    runningRevision: 2,
    error: "Last start exited early.",
    diagnostics: ["spawned pid 42", "listener exited"],
  });
  data.agents.push(
    {
      ...structuredClone(agent),
      id: "foreign",
      relayUrl: "wss://other.example.test",
      name: "Foreign copy",
      status: "stopped",
      runningRevision: null,
    },
    { ...structuredClone(agent), id: "namesake", pubkey: "cd".repeat(32) },
  );
  const community = relayAt(home);
  mount(control, community.relay);
  await settle(0, data);
  const summary = await screen.findByRole("region", { name: "Local agent" });
  expect(within(summary).getByRole("status")).toHaveTextContent(
    "Process running · relay readiness unverified",
  );
  expect(summary).toHaveTextContent("fixture-acp");
  expect(summary).toHaveTextContent("fixture-provider");
  expect(summary).toHaveTextContent("fixture-model");
  expect(summary).toHaveTextContent("/fixture/workspace");
  expect(summary).toHaveTextContent(
    "Saved settings; environment overrides may apply.",
  );
  expect(summary).toHaveTextContent(
    "Saved revision 3 is not running yet (running revision 2).",
  );
  // The host error is owned by the actions section, not repeated here.
  expect(summary).not.toHaveTextContent("Last start exited early.");
  expect(
    screen.getByRole("region", { name: "Local agent actions" }),
  ).toHaveTextContent("Last start exited early.");
  expect(summary).not.toHaveTextContent("Process stopped");
  expect(within(summary).queryByText("Instructions")).toBeNull();
  await userEvent.click(within(summary).getByText("Host diagnostics"));
  expect(
    within(summary).getByText(/spawned pid 42\s+listener exited/),
  ).toBeVisible();
  // Values that could be secrets never reach this view.
  expect(summary).not.toHaveTextContent("EXAMPLE_TOKEN");
  expect(summary).not.toHaveTextContent("--literal");

  community.move(elsewhere);
  expect(screen.getByRole("region", { name: "Profile details" })).toBeVisible();
  const moved = await screen.findByRole("region", { name: "Local agent" });
  // Same key saved for the other community is a separate native record.
  expect(within(moved).getByRole("status")).toHaveTextContent(
    "Process stopped",
  );
  expect(moved).not.toHaveTextContent("Saved revision 3 is not running");

  community.move(`https://third.example.test:${viewer}`);
  await screen.findByRole("region", { name: "Profile details" });
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
});

it("renders nothing for an unknown key in the same community", async () => {
  const { control, settle, data, agent } = heldHost();
  agent.relayUrl = "wss://relay.example.test";
  const community = relayAt(home);
  mount(control, community.relay, "cd".repeat(32));
  await settle(0, data);
  expect(control.snapshot().status).toBe("ready");
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
});

it("follows native status transitions and marks failed reads as unconfirmed evidence", async () => {
  const { control, reads, settle, data, agent } = heldHost();
  Object.assign(agent, {
    relayUrl: "wss://relay.example.test",
    status: "stopped",
    runningRevision: null,
    diagnostics: [],
  });
  mount(control, relayAt(home).relay);
  // Loading with no evidence stays public-only.
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  expect(control.snapshot().status).toBe("loading");
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
  await settle(0, data);
  const status = () =>
    within(screen.getByRole("region", { name: "Local agent" })).getByRole(
      "status",
    );
  expect(status()).toHaveTextContent("Process stopped");
  expect(screen.queryByText("Host diagnostics")).toBeNull();

  for (const [next, label] of [
    ["starting", "Starting process"],
    ["running", "Process running · relay readiness unverified"],
    ["failed", "Process failed"],
  ] as const) {
    agent.status = next;
    const index = reads.length;
    void control.refresh();
    await settle(index, data);
    expect(status()).toHaveTextContent(label);
  }

  let index = reads.length;
  void control.refresh();
  await settle(index, "host crashed");
  // Last evidence stays; the actions section owns the unconfirmed notice and Retry.
  expect(status()).toHaveTextContent("Process failed");
  const summary = screen.getByRole("region", { name: "Local agent" });
  expect(within(summary).queryByRole("alert")).toBeNull();
  const actions = screen.getByRole("region", { name: "Local agent actions" });
  expect(actions).toHaveTextContent("unconfirmed");

  agent.status = "running";
  index = reads.length;
  await userEvent.click(
    within(actions).getByRole("button", { name: "Retry status" }),
  );
  await settle(index, data);
  expect(status()).toHaveTextContent("Process running");
  expect(within(actions).queryByRole("alert")).toBeNull();
  expect(actions).not.toHaveTextContent("unconfirmed");
});

it("leaves the unavailable-runtime explanation to the actions section", async () => {
  const { control, settle, data, agent } = heldHost();
  agent.relayUrl = "wss://relay.example.test";
  data.runtimeAvailable = false;
  data.runtimeMessage = "Agent runtime resources are missing.";
  mount(control, relayAt(home).relay);
  await settle(0, data);
  const summary = await screen.findByRole("region", { name: "Local agent" });
  expect(summary).not.toHaveTextContent("Agent runtime resources are missing.");
  expect(
    screen.getByRole("region", { name: "Local agent actions" }),
  ).toHaveTextContent("Agent runtime resources are missing.");
});

it("requests a read on each Info open, coalescing re-entry while one is pending", async () => {
  const { control, reads, settle, data, agent } = heldHost();
  agent.relayUrl = "wss://relay.example.test";
  mount(control, relayAt(home, true).relay);
  const reenter = async () => {
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Info" }));
    await act(async () => {});
  };
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  // ProfileAgentRuntime owns this read; inventory waits before deciding its tab.
  expect(screen.queryByRole("region", { name: "Instances" })).toBeNull();
  await reenter();
  expect(reads).toHaveLength(1);
  await settle(0, data);
  await screen.findByRole("region", { name: "Local agent" });
  for (const index of [1, 2]) {
    await reenter();
    await vi.waitFor(() => expect(reads).toHaveLength(index + 1));
    expect(screen.getByRole("region", { name: "Local agent" })).toBeVisible();
    await reenter();
    expect(reads).toHaveLength(index + 1);
    await settle(index, data);
  }
});

async function openRuntimeLog() {
  await userEvent.click(await screen.findByRole("tab", { name: "Runtime" }));
  await userEvent.click(screen.getByRole("button", { name: "Harness log" }));
}

it("opens the exact local log, polls while focused, and drops it on a community change", async () => {
  const readLog = vi.fn(async () => "first line\nsecond line");
  const fixture = controlFixture();
  const { control, settle, data, agent } = heldHost(fixture, readLog);
  const community = relayAt(home);
  mount(control, community.relay);
  await settle(0, data);
  await openRuntimeLog();
  const log = await screen.findByRole("region", { name: "Harness log" });
  expect(
    within(log).getByTestId("managed-agent-log-content"),
  ).toHaveTextContent("first line");
  expect(screen.queryByRole("tab", { name: "Runtime" })).toBeNull();
  await userEvent.click(within(log).getByRole("button", { name: "Back" }));
  expect(screen.getByRole("tab", { name: "Runtime" })).toBeVisible();
  await openRuntimeLog();
  expect(readLog).toHaveBeenCalledWith({
    id: agent.id,
    pubkey: agent.pubkey,
    relayUrl: agent.relayUrl,
    authorize: expect.any(Function),
  });
  community.move(elsewhere);
  expect(screen.queryByRole("region", { name: "Harness log" })).toBeNull();
});

it("shows loading, empty, and failure without echoing host errors or stale output", async () => {
  let resolve!: (content: string) => void;
  let reject!: (error: string) => void;
  const readLog = vi.fn(
    () =>
      new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const fixture = controlFixture();
  const { control, settle, data } = heldHost(fixture, readLog);
  mount(control, relayAt(home).relay);
  await settle(0, data);
  await openRuntimeLog();
  expect(
    within(screen.getByRole("region", { name: "Harness log" })).getByRole(
      "status",
    ),
  ).toHaveAccessibleName("Loading harness log");
  expect(
    screen.getByRole("status", { name: "Loading harness log" }),
  ).toHaveTextContent("Loading harness log");
  await act(async () => resolve(""));
  expect(screen.getByTestId("managed-agent-log-content")).toHaveTextContent(
    "No log output yet.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await openRuntimeLog();
  await vi.waitFor(() => expect(readLog.mock.calls.length).toBeGreaterThan(2));
  await act(async () => reject("secret host path"));
  expect(
    within(screen.getByRole("region", { name: "Harness log" })).getByRole(
      "alert",
    ),
  ).toHaveTextContent("Could not read harness log.");
  expect(screen.queryByText("secret host path")).toBeNull();
});

it("retires an in-flight log read when the native target disappears without remounting", async () => {
  let complete!: (content: string) => void;
  const readLog = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const { control, settle, data } = heldHost(controlFixture(), readLog);
  mount(control, relayAt(home).relay);
  await settle(0, data);
  await openRuntimeLog();
  await screen.findByRole("region", { name: "Harness log" });
  await vi.waitFor(() => expect(readLog).toHaveBeenCalled());

  const refresh = control.refresh();
  await settle(1, { ...data, agents: [] });
  await refresh;
  expect(screen.queryByRole("region", { name: "Harness log" })).toBeNull();
  await act(async () => complete("late private output"));
  expect(screen.queryByText("late private output")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy log" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Harness log" })).toBeNull();
});

it("retires a held log read on auth-only owner loss without native or community changes", async () => {
  let complete!: (content: string) => void;
  const readLog = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const { control, settle, data } = heldHost(controlFixture(), readLog);
  const community = relayAt(home);
  mount(control, community.relay);
  await settle(0, data);
  await openRuntimeLog();
  await vi.waitFor(() => expect(readLog).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("region", { name: "Harness log" })).toBeVisible();

  await community.revokeOwner();
  await vi.waitFor(() =>
    expect(screen.queryByRole("region", { name: "Harness log" })).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "Harness log" })).toBeNull();
  await act(async () => complete("late private output"));
  expect(screen.queryByText("late private output")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy log" })).toBeNull();
  expect(readLog).toHaveBeenCalledTimes(2);
});

it("retires the log after a rejected same-head ownership refresh until recovery", async () => {
  const reads: Array<(content: string) => void> = [];
  const readLog = vi.fn(
    () => new Promise<string>((resolve) => reads.push(resolve)),
  );
  const { control, settle, data } = heldHost(controlFixture(), readLog);
  const community = relayAt(home);
  const intervals = vi.spyOn(window, "setInterval");
  const cleared = vi.spyOn(window, "clearInterval");
  mount(control, community.relay);
  await settle(0, data);
  await openRuntimeLog();
  await vi.waitFor(() => expect(readLog).toHaveBeenCalledTimes(2));
  const logTimers = intervals.mock.results
    .filter((_, index) => intervals.mock.calls[index]?.[1] === 30_000)
    .map((result) => result.value);
  expect(logTimers).toHaveLength(2);
  const log = screen.getByRole("region", { name: "Harness log" });
  // The admitted head stays readable during a pending refresh of that same head.
  const pending = community.holdOwnerRead();
  const refresh = community.refreshOwnership();
  try {
    await pending.started;
    expect(log).toBeVisible();
    community.failOwner(true);
  } finally {
    pending.release();
    await act(async () => {
      await refresh;
    });
  }
  await vi.waitFor(() =>
    expect(screen.queryByRole("region", { name: "Harness log" })).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "Harness log" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy log" })).toBeNull();
  expect(
    logTimers.every((timer) => cleared.mock.calls.some(([id]) => id === timer)),
  ).toBe(true);
  intervals.mockRestore();
  cleared.mockRestore();
  await act(async () => {
    for (const resolve of reads) resolve("late private output");
  });
  expect(screen.queryByText("late private output")).toBeNull();
  // A settled failed refresh must not keep the view or its polling timer alive.
  // StrictMode replay accounts for the two initial reads.
  expect(readLog).toHaveBeenCalledTimes(2);
  community.failOwner(false);
  await userEvent.click(screen.getByRole("tab", { name: "Info" }));
  await userEvent.click(screen.getByRole("button", { name: "Retry profile" }));
  await userEvent.click(await screen.findByRole("tab", { name: "Runtime" }));
  expect(
    await screen.findByRole("button", { name: "Harness log" }),
  ).toBeVisible();
  expect(readLog).toHaveBeenCalledTimes(2);
});

it("hides the log entry from a viewer who does not own the signed agent", async () => {
  const readLog = vi.fn(async () => "private output");
  const { control, settle, data } = heldHost(controlFixture(), readLog);
  mount(control, relayAt(home, false, false).relay);
  await settle(0, data);
  await screen.findByRole("region", { name: "Local agent" });
  expect(screen.queryByRole("button", { name: "Harness log" })).toBeNull();
  expect(readLog).not.toHaveBeenCalled();
});

it("keeps StrictMode replayed log reads independent and consumes each challenge once", async () => {
  const pending = new Map<number, boolean>();
  let nextNonce = 0;
  const readLog = vi.fn(async () => {
    const nonce = ++nextNonce;
    pending.set(nonce, true);
    // Model the broker hop: two native challenges can be outstanding at once.
    await Promise.resolve();
    if (!pending.delete(nonce)) throw new Error("Log authorization expired");
    return `output ${nonce}`;
  });
  const { control, settle, data } = heldHost(controlFixture(), readLog);
  mount(control, relayAt(home).relay);
  await settle(0, data);
  await openRuntimeLog();
  await vi.waitFor(() => expect(readLog).toHaveBeenCalledTimes(2));
  const log = await screen.findByRole("region", { name: "Harness log" });
  await vi.waitFor(() =>
    expect(
      within(log).getByTestId("managed-agent-log-content"),
    ).toHaveTextContent("output 2"),
  );
  expect(within(log).queryByRole("alert")).toBeNull();
  expect(pending.size).toBe(0);
});

it("polls the focused log every 30 seconds only while visible, and stops on unmount", async () => {
  const readLog = vi.fn(async () => "safe fixture output");
  const { control } = heldHost(controlFixture(), readLog);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  vi.useFakeTimers();
  try {
    const view = render(
      <StrictMode>
        <ProfileHarnessLog
          name="Fixture"
          control={control}
          target={{
            id: "fixture",
            pubkey: agentKey,
            relayUrl: "wss://relay.example.test",
            authorize: async () => "fixture-signature",
          }}
          onBack={() => {}}
        />
      </StrictMode>,
    );
    await act(async () => {});
    expect(readLog).toHaveBeenCalledTimes(2); // StrictMode replays the effect.
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(readLog).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(readLog).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue("hidden");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(readLog).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue("visible");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(readLog).toHaveBeenCalledTimes(4);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(readLog).toHaveBeenCalledTimes(4);
  } finally {
    visibility.mockRestore();
    vi.useRealTimers();
  }
});
