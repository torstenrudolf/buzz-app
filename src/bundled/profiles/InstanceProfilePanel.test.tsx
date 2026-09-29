// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { StrictMode, useState } from "react";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { LiveCallbacks } from "../../features/relay/live";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { keypair, signed } from "../../features/relay/testing";
import { attestedOwner } from "../../features/agents/owner-attestation";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import {
  instanceTarget,
  parseInstanceTarget,
} from "../../features/profiles/instance-target";
import { profileTarget } from "../../features/profiles/target";
import { InstanceProfilePanel } from "./InstanceProfilePanel";
import { ProfilePanel } from "./ProfilePanel";
vi.mock("../../features/agents/owner-attestation", async (original) => {
  const actual =
    await original<typeof import("../../features/agents/owner-attestation")>();
  return { attestedOwner: vi.fn(actual.attestedOwner) };
});
const verify = vi.mocked(attestedOwner);
const viewer = keypair(),
  identity = keypair(),
  stranger = keypair();
const origin = "https://buzz.block.builderlab.xyz";
const disposables: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  verify.mockReset();
  for (const owner of disposables.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function fixture({
  owner = viewer,
  archived = false,
  initial = "second",
  holdOwner = false,
} = {}) {
  const head = signed(identity, {
    kind: 0,
    content: JSON.stringify({ name: "Identity", is_agent: true }),
    tags: [
      [
        "auth",
        owner.pubkey,
        "",
        bytesToHex(
          schnorr.sign(
            new Uint8Array(
              createHash("sha256")
                .update(`nostr:agent-auth:${identity.pubkey}:`)
                .digest(),
            ),
            owner.secret,
          ),
        ),
      ],
    ],
  });
  let callbacks: LiveCallbacks | undefined;
  let failOwner = false;
  let releaseOwner = () => {};
  let ownerGate = holdOwner
    ? new Promise<void>((resolve) => {
        releaseOwner = resolve;
      })
    : Promise.resolve();
  let ownerReadStarted = () => {};
  const sessionOwner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: viewer.pubkey,
    subscribe(next) {
      callbacks = next;
      return { update() {}, retry() {}, dispose() {} };
    },
    media: () => undefined,
    query: async (filters) => {
      if (!filters.some((f) => f.kinds?.includes(0))) return [];
      ownerReadStarted();
      await ownerGate;
      if (failOwner) throw new Error("Fixture ownership unavailable");
      return [head];
    },
  });
  const archiveSnapshot = {
    status: "ready" as const,
    archived: archived ? [identity.pubkey] : [],
  };
  const ownershipViews: ReturnType<typeof sessionOwner.session.observe>[] = [];
  const session = {
    ...sessionOwner.session,
    observe: (...args: Parameters<typeof sessionOwner.session.observe>) => {
      const view = sessionOwner.session.observe(...args);
      ownershipViews.push(view);
      return view;
    },
    archives: {
      ...sessionOwner.session.archives,
      snapshot: () => archiveSnapshot,
    },
  };
  const native = controlFixture();
  Object.assign(native.agent, {
    id: "first",
    pubkey: identity.pubkey,
    relayUrl: "wss://buzz.block.builderlab.xyz/",
    name: "First",
    status: "stopped",
    enabled: false,
    runningRevision: null,
    workspace: "/first",
    systemPrompt: "First instructions",
  });
  native.data.agents.push({
    ...structuredClone(native.agent),
    id: "second",
    name: "Second",
    workspace: "/second",
    systemPrompt: "Second instructions",
  });
  let failRead = false;
  let failAction = false;
  const control = createAgentControl({
    ...native.host,
    async snapshot() {
      if (failRead) throw new Error("Fixture host unavailable");
      return native.host.snapshot();
    },
    async action(id, action) {
      native.calls.push({ action, payload: { id } });
      if (failAction) throw new Error("Fixture action rejected");
      const selected = native.data.agents.find((agent) => agent.id === id);
      if (!selected) throw new Error("Missing fixture agent");
      selected.enabled = action !== "stop";
      selected.status = action === "stop" ? "stopped" : "running";
      return structuredClone(native.data);
    },
  });
  disposables.push(sessionOwner, control);
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer: viewer.pubkey,
    scope: `${origin}:${viewer.pubkey}`,
    session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: (f) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    retry() {},
    disconnect() {},
    clearCache: sessionOwner.clearCache,
  };
  const target = (id: string) =>
    instanceTarget({
      id,
      pubkey: identity.pubkey,
      viewer: viewer.pubkey,
      communityOrigin: origin,
    });
  const opened = vi.fn();
  function Host() {
    const [current, select] = useState(
      initial ? target(initial) : (profileTarget(identity.pubkey) ?? ""),
    );
    const context = {
      channelId: "fixture",
      canOpen: () => true,
      open: (next: string) => {
        opened(next);
        select(next);
        return true;
      },
    };
    const props = { relay, control, context, target: current, close: () => {} };
    const instance = parseInstanceTarget(current);
    return instance ? (
      <InstanceProfilePanel {...props} instance={instance} />
    ) : (
      <ProfilePanel {...props} />
    );
  }
  render(
    <StrictMode>
      <Host />
    </StrictMode>,
  );
  return {
    native,
    control,
    opened,
    target,
    sessionOwner,
    releaseOwner,
    holdOwnerRead() {
      const started = new Promise<void>((resolve) => {
        ownerReadStarted = resolve;
      });
      ownerGate = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      return { started, release: () => releaseOwner() };
    },
    beginOwnershipRefresh() {
      return Promise.all(ownershipViews.map((view) => view.refresh()));
    },
    async updateSameOwner() {
      const next = signed(identity, {
        kind: 0,
        content: JSON.stringify({ name: "Updated identity", is_agent: true }),
        tags: head.tags,
        created_at: head.created_at + 1,
      });
      await act(async () => callbacks?.receive([next]));
      return next;
    },
    failOwner(value: boolean) {
      failOwner = value;
    },
    failAction(value: boolean) {
      failAction = value;
    },
    async refreshOwnership() {
      await act(async () => {
        await Promise.all(ownershipViews.map((view) => view.refresh()));
      });
    },
    async revokeOwner() {
      if (!callbacks) throw new Error("Fixture subscription not mounted");
      const next = signed(identity, {
        kind: 0,
        content: head.content,
        tags: [],
        created_at: head.created_at + 1,
      });
      await act(async () => callbacks?.receive([next]));
    },
    failRead(value: boolean) {
      failRead = value;
    },
    move: async () => {
      await act(async () => {
        snapshot = {
          ...snapshot,
          viewer: stranger.pubkey,
          scope: `${origin}:${stranger.pubkey}`,
          generation: 2,
        };
        for (const listener of listeners) listener();
      });
    },
  };
}
it.each([false, true])(
  "selects exact native details/actions, including archived=%s, and returns to the identity",
  async (archived) => {
    const f = fixture({ archived });
    const user = userEvent.setup();
    const runtime = await screen.findByRole("region", { name: "Local agent" });
    expect(within(runtime).getByText("/second")).toBeVisible();
    expect(within(runtime).queryByText("First instructions")).toBeNull();
    await user.click(await screen.findByRole("tab", { name: "Runtime" }));
    const rows = screen.getByRole("region", { name: "Instances" });
    await user.click(within(rows).getByText("2 instances"));
    expect(
      within(rows).getByRole("button", { name: "Second" }),
    ).toHaveAttribute("aria-current", "true");
    expect(within(rows).queryAllByText("Archived")).toHaveLength(
      archived ? 2 : 0,
    );
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(f.native.agent.status).toBe("stopped"));
    expect(f.native.data.agents[1]?.status).toBe("running");
    await user.click(screen.getByRole("tab", { name: "Runtime" }));
    await user.click(screen.getByText("2 instances"));
    await user.click(screen.getByRole("button", { name: "First" }));
    expect(await screen.findByText("/first")).toBeVisible();
    expect(screen.queryByText("/second")).toBeNull();
    expect(f.opened).toHaveBeenLastCalledWith(f.target("first"));
    await user.click(screen.getByRole("button", { name: "Back to profile" }));
    expect(screen.getByRole("heading", { name: "Identity" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Runtime" }));
    await user.click(screen.getByText("2 instances"));
    await user.click(screen.getByRole("button", { name: "Second" }));
    expect(await screen.findByText("/second")).toBeVisible();
    await f.move();
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.queryByText("/second")).toBeNull();
  },
);
it("does not substitute the first sibling after deletion", async () => {
  const f = fixture();
  await screen.findByText("/second");
  f.native.data.agents.splice(1);
  await act(async () => {
    await f.control.refresh();
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
  expect(screen.queryByText("/first")).toBeNull();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});
it("retains exact native recovery after a failed read", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByText("/second");
  f.failRead(true);
  await act(async () => {
    await f.control.refresh();
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not refresh local agents.",
  );
  expect(screen.getByText("/second")).toBeVisible();
  expect(screen.getByText(/Showing the last host snapshot/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Start" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(f.native.calls.some((call) => call.action === "start")).toBe(false);
  expect(screen.queryByRole("button", { name: "Retry agents" })).toBeNull();
  f.failRead(false);
  await user.click(screen.getByRole("button", { name: "Retry status" }));
  expect(await screen.findByText("/second")).toBeVisible();
  expect(screen.queryByText("/first")).toBeNull();
});
it("rejects a non-owner even with native custody and a forged target", async () => {
  const f = fixture({ owner: stranger });
  await act(async () => {
    await f.sessionOwner.session.profiles.ensure([identity.pubkey]);
    await f.control.refresh();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(screen.queryByText("/second")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Local agent actions" }),
  ).toBeNull();
});
it("revokes mounted private details after an auth-only profile update", async () => {
  const f = fixture();
  await screen.findByText("/second");
  await f.revokeOwner();
  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(screen.queryByText("/second")).toBeNull();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});
it("opens each row from the ordinary profile rather than generic Agents", async () => {
  const f = fixture({ initial: "" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Runtime" }));
  const instances = screen.getByRole("region", { name: "Instances" });
  expect(within(instances).getByText("2 instances")).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Agent configuration" }),
  ).toBeNull();
  await user.click(within(instances).getByText("2 instances"));
  await user.click(within(instances).getByRole("button", { name: "Second" }));
  expect(await screen.findByText("/second")).toBeVisible();
  expect(f.opened).toHaveBeenCalledWith(f.target("second"));
});

it("keeps exact Runtime recovery with multiple siblings after a failed native read", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByText("/second");
  await user.click(await screen.findByRole("tab", { name: "Runtime" }));
  expect(
    screen.getByRole("region", { name: "Agent configuration" }),
  ).toBeVisible();
  expect(screen.getByRole("region", { name: "Advanced" })).toHaveTextContent(
    "/second",
  );
  expect(
    screen.getByRole("region", { name: "Advanced" }),
  ).not.toHaveTextContent("/first");
  f.failRead(true);
  await act(async () => {
    await f.control.refresh();
  });
  expect(screen.getByRole("button", { name: "Retry status" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry agents" })).toBeNull();
  f.failRead(false);
  await user.click(screen.getByRole("button", { name: "Retry status" }));
  expect(
    await screen.findByRole("region", { name: "Instances" }),
  ).toHaveTextContent("2 instances");
  expect(
    screen.getByRole("region", { name: "Agent configuration" }),
  ).toBeVisible();
});

it("keeps ambiguous Runtime discovery recoverable after a failed native read", async () => {
  const f = fixture({ initial: "" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Runtime" }));
  expect(
    screen.queryByRole("region", { name: "Agent configuration" }),
  ).toBeNull();
  f.failRead(true);
  await act(async () => {
    await f.control.refresh();
  });
  const instances = screen.getByRole("region", { name: "Instances" });
  expect(within(instances).getByRole("alert")).toHaveTextContent(
    "Could not refresh managed agents.",
  );
  f.failRead(false);
  await user.click(
    within(instances).getByRole("button", { name: "Retry agents" }),
  );
  expect(await within(instances).findByText("2 instances")).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Agent configuration" }),
  ).toBeNull();
});

it("announces loading while ownership is pending, not unavailable", async () => {
  const f = fixture({ holdOwner: true });
  try {
    await act(async () => {
      await f.control.refresh();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("/second")).toBeNull();
  } finally {
    await act(async () => f.releaseOwner());
  }
  expect(await screen.findByText("/second")).toBeVisible();
});
it("fails closed on rejected ownership refresh, retries, and observes newer revocation", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByText("/second");
  f.failOwner(true);
  await f.refreshOwnership();
  expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
  expect(screen.queryByText("/second")).toBeNull();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  expect(f.control.snapshot().status).toBe("ready");
  f.failOwner(false);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("/second")).toBeVisible();
  await f.revokeOwner();
  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(screen.queryByText("/second")).toBeNull();
});
it("retains selected details and recovery Stop after a rejected action", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByText("/second");
  await user.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByRole("button", { name: "Stop" });
  f.failAction(true);
  await user.click(screen.getByRole("button", { name: "Restart" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not confirm the operation.",
  );
  expect(screen.getByText("/second")).toBeVisible();
  expect(screen.getByText(/Showing the last host snapshot/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Retry agents" })).toBeNull();
  f.failAction(false);
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(f.native.data.agents[1]?.status).toBe("stopped"));
  expect(screen.getByText("/second")).toBeVisible();
  expect(f.native.calls.at(-1)).toMatchObject({
    action: "stop",
    payload: { id: "second" },
  });
});

it("keeps the selected tab, detail node and focus during a held same-head refresh", async () => {
  const f = fixture();
  const user = userEvent.setup();
  // Finish initial roster access reconciliation before measuring the refresh.
  await act(async () => {
    await f.sessionOwner.session.channels.refreshList?.();
  });
  await screen.findByText("/second");
  const detail = screen.getByRole("region", { name: "Profile details" });
  const tab = screen.getByRole("tab", { name: "Channels" });
  await user.click(tab);
  const held = f.holdOwnerRead();
  let refresh: Promise<unknown> | undefined;
  try {
    await act(async () => {
      refresh = f.beginOwnershipRefresh();
      await held.started;
    });
    expect(screen.getByRole("region", { name: "Profile details" })).toBe(
      detail,
    );
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveFocus();
    expect(screen.queryByText("Loading…")).toBeNull();
  } finally {
    await act(async () => {
      held.release();
      await refresh;
    });
  }
  expect(screen.getByRole("region", { name: "Profile details" })).toBe(detail);
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(tab).toHaveFocus();
});
it("withholds private detail until a new same-owner head is verified", async () => {
  const f = fixture();
  await screen.findByText("/second");
  const original = await vi.importActual<
    typeof import("../../features/agents/owner-attestation")
  >("../../features/agents/owner-attestation");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  verify.mockImplementation(async (event) => {
    await gate;
    return original.attestedOwner(event);
  });
  try {
    const next = await f.updateSameOwner();
    await waitFor(() =>
      expect(
        verify.mock.calls.some(
          ([event]) => event.created_at === next.created_at,
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(
      screen.queryByRole("region", { name: "Profile details" }),
    ).toBeNull();
    expect(screen.queryByText("/second")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByText("/second")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Updated identity" }),
  ).toBeVisible();
});

it("owns one read-only refresh cadence across nested instance controls and tab changes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = fixture({ holdOwner: true });
  try {
    await act(() => f.control.refresh());
    // Offset child mounting from the outer interval. Simultaneous timers can
    // coalesce in the controller and conceal duplicate refresh ownership.
    await act(() => vi.advanceTimersByTimeAsync(1000));
  } finally {
    f.releaseOwner();
  }
  await screen.findByRole("button", { name: /^Start$/ });
  const count = () =>
    f.native.calls.filter((call) => call.action === "snapshot").length;
  const initial = count();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(count() - initial).toBe(3);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Runtime" }));
  const runtime = count();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(count() - runtime).toBe(2);
  expect(f.native.calls.every((call) => call.action === "snapshot")).toBe(true);
  cleanup();
  const stopped = count();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(count()).toBe(stopped);
});
