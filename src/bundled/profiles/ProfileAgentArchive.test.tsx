// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { StrictMode } from "react";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { LiveCallbacks } from "../../features/relay/live";
import type { RelayData } from "../../features/relay/service";
import {
  archiveRelay,
  keypair,
  signed,
  type Key,
} from "../../features/relay/testing";
import { profileTarget } from "../../features/profiles/target";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { PublishRejected } from "../../features/relay/outbox";
import { removeAgentFromChannels } from "./ProfileAgentDelete";
import { ProfilePanel } from "./ProfilePanel";

const viewer = keypair(),
  relay = keypair(),
  agent = keypair(),
  stranger = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
function attested(owner: Key) {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent.pubkey}:`)
    .digest();
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Agent", is_agent: true }),
    tags: [
      [
        "auth",
        owner.pubkey,
        "",
        bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
      ],
    ],
  });
}
function mount(owner: Key = viewer) {
  return mountWith(archiveRelay(viewer, relay, [attested(owner)]));
}
function mountWith(
  fixture: ReturnType<typeof archiveRelay>,
  control?: ReturnType<typeof createAgentControl>,
  close = () => {},
  load: () => readonly never[] | Promise<readonly never[]> = () => [],
) {
  const instance = createRelaySession(fixture.transport, {
    outboxStorage: { load, save: () => {} },
  });
  owners.push(instance);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    scope: `https://one.example:${viewer.pubkey}`,
    session: instance.session,
  };
  const data: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: instance.clearCache,
  };
  render(
    <StrictMode>
      <ProfilePanel
        relay={data}
        target={profileTarget(agent.pubkey) ?? ""}
        {...(control ? { control } : {})}
        close={close}
      />
    </StrictMode>,
  );
  return Object.assign(fixture, { instance });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("verified owner archives through the base confirmation, sees pending, flair and unarchives", async () => {
  const fixture = mount();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Archive agent" }),
  );
  const dialog = await screen.findByRole("alertdialog", {
    name: "Archive this agent?",
  });
  expect(
    within(dialog).getByText("Archiving hides this agent from the space."),
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      "You can unarchive them at any time to restore them",
    ),
  ).toBeVisible();
  const gate = deferred();
  fixture.script.hold = gate.promise;
  try {
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByRole("button", { name: "Archiving…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  } finally {
    gate.release();
    delete fixture.script.hold;
  }
  expect(await screen.findByText("Archived on this relay")).toBeVisible();
  expect(screen.getByText("Visibility")).toBeVisible();
  expect(screen.getByText("Archived")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "What archived means" }),
  ).toBeVisible();
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
  // Unarchive is immediate in base Buzz: no confirmation dialog.
  await user.click(screen.getByRole("button", { name: "Unarchive agent" }));
  expect(await screen.findByText("Unarchived on this relay")).toBeVisible();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText("Visibility")).toBeNull();
  expect(screen.getByRole("button", { name: "Archive agent" })).toBeEnabled();
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 9036]);
});
it("a failed request reports the base failure text and keeps the prior state", async () => {
  const fixture = mount();
  const user = userEvent.setup();
  fixture.script.fail = new Error("restricted: not authorized");
  await user.click(
    await screen.findByRole("button", { name: "Archive agent" }),
  );
  await user.click(await screen.findByRole("button", { name: "Archive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Archive failed: restricted: not authorized",
  );
  expect(screen.getByRole("button", { name: "Archive agent" })).toBeEnabled();
  expect(screen.queryByText("Visibility")).toBeNull();
});
it("an unauthorized viewer sees archived state but no archive action or signing", async () => {
  const verify = vi.spyOn(schnorr, "verify");
  const fixture = mount(stranger);
  fixture.archiveExternally(agent.pubkey);
  expect(await screen.findByText("Archived")).toBeVisible();
  // Barrier: the consent check verified the foreign attestation and settled.
  await vi.waitFor(() => expect(verify).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /archive agent/i })).toBeNull();
  expect(fixture.signedBy).toEqual([]);
});
it("a mounted profile re-reads archive state after a disconnect and reconnect", async () => {
  const fixture = archiveRelay(viewer, relay, [attested(viewer)]);
  let live!: LiveCallbacks;
  mountWith({
    ...fixture,
    transport: {
      ...fixture.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
  });
  act(() => live.state({ status: "connected", routes: [] }));
  expect(
    await screen.findByRole("button", { name: "Archive agent" }),
  ).toBeVisible();
  fixture.archiveExternally(agent.pubkey);
  act(() => live.state({ status: "retrying", routes: [] }));
  act(() => live.state({ status: "connected", routes: [] }));
  expect(
    await screen.findByRole("button", { name: "Unarchive agent" }),
  ).toBeVisible();
  expect(screen.getByText("Archived")).toBeVisible();
});
it("a transient consent failure retries in the background without remounting", async () => {
  const fixture = archiveRelay(viewer, relay, [attested(viewer)]);
  const query = fixture.transport.query;
  // StrictMode's discarded first check consumes one failure.
  let failures = 2;
  fixture.transport.query = async (filters, ...rest) => {
    if (failures && filters.some((filter) => filter.kinds?.includes(13534))) {
      failures -= 1;
      throw new Error("offline");
    }
    return query(filters, ...rest);
  };
  mountWith(fixture);
  expect(
    await screen.findByRole(
      "button",
      { name: "Archive agent" },
      { timeout: 4000 },
    ),
  ).toBeVisible();
  expect(failures).toBe(0);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("an in-flight Archive blocks Delete before channel effects; retry succeeds", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  const hold = deferred();
  fixture.script.hold = hold.promise;
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Delete agent" }));
  const deleteConfirm = within(
    await screen.findByRole("alertdialog", { name: "Delete this agent?" }),
  ).getByRole("button", { name: "Delete agent" });
  // Another already-open confirmation can admit Archive before Delete commits.
  fireEvent.click(
    screen.getByRole("button", { name: "Archive agent", hidden: true }),
  );
  const archiveDialog = await screen.findByRole("alertdialog", {
    name: "Archive this agent?",
  });
  fireEvent.click(
    within(archiveDialog).getByRole("button", { name: "Archive" }),
  );
  expect(
    await screen.findByRole("button", { name: "Archiving…", hidden: true }),
  ).toBeVisible();
  fireEvent.click(deleteConfirm);
  expect(fixture.instance.session.outbox?.snapshot()).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
  hold.release();
  expect(await screen.findByText("Archived on this relay")).toBeVisible();
  delete fixture.script.hold;
  await confirmDelete(user);
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 9001]);
  expect(deletes(fixture)).toHaveLength(1);
});
it("Delete blocks an already-open Archive confirmation until removal settles", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  const hold = deferred();
  fixture.removal.hold = hold.promise;
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Archive agent" }),
  );
  const archiveDialog = await screen.findByRole("alertdialog", {
    name: "Archive this agent?",
  });
  const archiveConfirm = within(archiveDialog).getByRole("button", {
    name: "Archive",
  });
  // A second gesture opens Delete behind the first modal before Archive is submitted.
  fireEvent.click(
    screen.getByRole("button", { name: "Delete agent", hidden: true }),
  );
  const deleteDialog = await screen.findByRole("alertdialog", {
    name: "Delete this agent?",
  });
  fireEvent.click(
    within(deleteDialog).getByRole("button", { name: "Delete agent" }),
  );
  await vi.waitFor(() =>
    expect(fixture.instance.session.outbox?.snapshot()).toHaveLength(1),
  );
  fireEvent.click(archiveConfirm);
  expect(fixture.published).toEqual([]);
  hold.release();
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.published.map((event) => event.kind)).toEqual([9001, 9035]);
});

it("Delete blocks Unarchive while native removal is in flight", async () => {
  const fixture = mountManaged();
  fixture.archiveExternally(agent.pubkey);
  await act(() => fixture.instance.session.archives.refresh());
  const user = userEvent.setup();
  expect(
    await screen.findByRole("button", { name: "Unarchive agent" }),
  ).toBeVisible();
  const hold = deferred();
  const nativeDelete = fixture.native.host.delete?.bind(fixture.native.host);
  const spy = vi
    .spyOn(fixture.native.host, "delete")
    .mockImplementation(async (id, revision) => {
      await hold.promise;
      if (!nativeDelete) throw new Error("fixture delete");
      return nativeDelete(id, revision);
    });
  await confirmDelete(user);
  await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
  const unarchive = screen.getByRole("button", { name: "Unarchive agent" });
  expect(unarchive).toBeDisabled();
  fireEvent.click(unarchive);
  expect(fixture.published).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
  hold.release();
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
});

/** Synthetic native host managing only the fixture agent in this community. */
function managed(managedHere = true) {
  const native = controlFixture();
  native.agent.pubkey = agent.pubkey;
  native.agent.relayUrl = "wss://one.example";
  if (!managedHere) native.data.agents.splice(0);
  const control = createAgentControl(native.host);
  return { native, control };
}
const room = "11111111-1111-4111-8111-111111111111",
  hidden = "22222222-2222-4222-8222-222222222222";
function mountManaged(
  owner: Key = viewer,
  managedHere = true,
  channels: Record<string, string[]> = {},
  load?: () => Promise<readonly never[]>,
) {
  const { native, control } = managed(managedHere);
  const close = vi.fn();
  const fixture = mountWith(
    archiveRelay(viewer, relay, [attested(owner)], {}, channels),
    control,
    close,
    load,
  );
  return Object.assign(fixture, { native, control, close });
}
const deletes = (fixture: ReturnType<typeof mountManaged>) =>
  fixture.native.calls.filter((call) => call.action === "delete");
async function confirmDelete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Delete agent" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete agent",
    }),
  );
}

it("verified owner deletes through the base confirmation: confirmed channel removals, then archive, then native removal, then close", async () => {
  const fixture = mountManaged(viewer, true, {
    [room]: [viewer.pubkey, agent.pubkey],
    // A channel outside the viewer's loaded list still lists the agent.
    [hidden]: [agent.pubkey],
  });
  const before: number[] = [];
  const nativeDelete = fixture.native.host.delete?.bind(fixture.native.host);
  vi.spyOn(fixture.native.host, "delete").mockImplementation(
    async (id, revision) => {
      before.push(...fixture.published.map((event) => event.kind));
      if (!nativeDelete) throw new Error("fixture delete");
      return nativeDelete(id, revision);
    },
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Delete agent" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete this agent?",
  });
  for (const text of [
    "Deleting this agent stops and removes the agent from this community.",
    "Removes the local management record and saved agent key",
    "Removes the agent from every channel it belongs to",
    "Archives the agent's identity on the relay so it no longer appears in member lists or mention suggestions",
    "Stops any local agent process before deleting the record",
    "Archive this agent if you want to hide it instead of removing it.",
  ])
    expect(within(dialog).getByText(text)).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", { name: "Delete agent" }),
  );
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(deletes(fixture)).toEqual([
    { action: "delete", payload: { id: "fixture-agent", expectedRevision: 1 } },
  ]);
  // Native removal ran only after every relay effect was confirmed.
  expect(before).toEqual([9001, 9001, 9035]);
  expect(
    fixture.published
      .filter((event) => event.kind === 9001)
      .map((event) => event.tags.slice(0, 2))
      .sort(),
  ).toEqual([
    [
      ["h", room],
      ["p", agent.pubkey],
    ],
    [
      ["h", hidden],
      ["p", agent.pubkey],
    ],
  ]);
  expect(fixture.channels).toEqual({ [room]: [viewer.pubkey], [hidden]: [] });
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
  // Roster-confirmed removals leave nothing outstanding in the outbox.
  await vi.waitFor(() =>
    expect(fixture.instance.session.outbox?.snapshot()).toEqual([]),
  );
});
it("cancel leaves the agent untouched", async () => {
  const fixture = mountManaged();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Delete agent" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fixture.native.calls.some((call) => call.action === "delete")).toBe(
    false,
  );
  expect(fixture.published).toEqual([]);
});
it.each([
  ["a foreign NIP-OA owner", stranger, true],
  ["the owner of an agent not managed here", viewer, false],
] as const)("%s gets no delete action", async (_, owner, managedHere) => {
  const verify = vi.spyOn(schnorr, "verify");
  const fixture = mountManaged(owner, managedHere);
  await vi.waitFor(() => expect(verify).toHaveBeenCalled());
  await act(async () => {});
  if (managedHere)
    expect(screen.queryByRole("button", { name: /archive agent/i })).toBeNull();
  else
    expect(
      await screen.findByRole("button", { name: "Archive agent" }),
    ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Delete agent" })).toBeNull();
  expect(fixture.native.calls.some((call) => call.action === "delete")).toBe(
    false,
  );
});
it("a failed native delete after confirmed relay effects reports it and stays open", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  vi.spyOn(fixture.native.host, "delete").mockRejectedValue(
    "Synthetic native refusal",
  );
  await confirmDelete(userEvent.setup());
  const [error] = await screen.findAllByText(
    /Synthetic native refusal\. Could not confirm the operation\. Check current status and saved settings before retrying/,
  );
  expect(error).toBeVisible();
  expect(fixture.published.map((event) => event.kind)).toEqual([9001, 9035]);
  expect(fixture.close).not.toHaveBeenCalled();
  // The record is intact, so Delete stays available to retry.
  expect(screen.getByRole("button", { name: "Delete agent" })).toBeEnabled();
});
it("a refused channel removal stops before archive and native removal; retry completes", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  fixture.removal.fail = new PublishRejected("restricted: not a member");
  const user = userEvent.setup();
  await confirmDelete(user);
  expect(await screen.findByText(/restricted: not a member/)).toBeVisible();
  expect(deletes(fixture)).toEqual([]);
  expect(fixture.published).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
  delete fixture.removal.fail;
  await confirmDelete(user);
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.published.map((event) => event.kind)).toEqual([9001, 9035]);
  expect(deletes(fixture)).toHaveLength(1);
});
it("an accepted removal the roster does not confirm stops before archive and native removal", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  fixture.removal.apply = false;
  await confirmDelete(userEvent.setup());
  expect(
    await screen.findByText(
      "The relay did not confirm removal from 1 channel. Retry.",
    ),
  ).toBeVisible();
  expect(fixture.published.map((event) => event.kind)).toEqual([9001]);
  expect(deletes(fixture)).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
});
it("a failed archive stops before native removal and keeps Delete and the Archive retry", async () => {
  const fixture = mountManaged();
  fixture.script.fail = new Error("restricted: not authorized");
  const user = userEvent.setup();
  await confirmDelete(user);
  expect(
    await screen.findByText("Archive failed: restricted: not authorized"),
  ).toBeVisible();
  expect(deletes(fixture)).toEqual([]);
  expect(fixture.control.snapshot().data?.agents).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Delete agent" })).toBeEnabled();
  expect(fixture.close).not.toHaveBeenCalled();
  delete fixture.script.fail;
  await user.click(screen.getByRole("button", { name: "Archive agent" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive",
    }),
  );
  expect(await screen.findByText("Archived on this relay")).toBeVisible();
});
it("closing the profile mid-removal cancels before archive and native removal", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  const held = deferred();
  fixture.removal.hold = held.promise;
  await confirmDelete(userEvent.setup());
  await vi.waitFor(() =>
    expect(fixture.instance.session.outbox?.snapshot()).toHaveLength(1),
  );
  cleanup();
  held.release();
  // The already-admitted removal settles; nothing may follow it.
  await vi.waitFor(() =>
    expect(fixture.instance.session.outbox?.snapshot()[0]?.delivery).toBe(
      "accepted",
    ),
  );
  await act(async () => {});
  expect(fixture.published.map((event) => event.kind)).toEqual([9001]);
  expect(deletes(fixture)).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
});
it("a held native Delete fences Unarchive after closing and reopening the same profile", async () => {
  const fixture = mountManaged();
  const held = deferred();
  const nativeDelete = fixture.native.host.delete?.bind(fixture.native.host);
  const spy = vi
    .spyOn(fixture.native.host, "delete")
    .mockImplementation(async (id, revision) => {
      await held.promise;
      if (!nativeDelete) throw new Error("fixture delete");
      return nativeDelete(id, revision);
    });
  try {
    await confirmDelete(userEvent.setup());
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    expect(fixture.archived.has(agent.pubkey)).toBe(true);
    cleanup();
    mountWith(fixture, fixture.control, fixture.close);
    const unarchive = await screen.findByRole("button", {
      name: "Unarchive agent",
    });
    expect(unarchive).toBeDisabled();
    fireEvent.click(unarchive);
    expect(fixture.signedBy).toHaveLength(1); // Delete's archive only.
    expect(fixture.published.map((event) => event.kind)).toEqual([9035]);
    expect(fixture.close).not.toHaveBeenCalled();
  } finally {
    held.release();
  }
  await vi.waitFor(() =>
    expect(fixture.control.snapshot().data?.agents).toEqual([]),
  );
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
  expect(fixture.published.map((event) => event.kind)).toEqual([9035]);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Unarchive agent" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Delete agent" })).toBeNull();
});

it("Archive confirmation checks controller busy even when it was already open", async () => {
  const fixture = mountManaged();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Archive agent" }),
  );
  const confirm = within(
    await screen.findByRole("alertdialog", { name: "Archive this agent?" }),
  ).getByRole("button", { name: "Archive" });
  const held = deferred();
  const nativeDelete = fixture.native.host.delete?.bind(fixture.native.host);
  vi.spyOn(fixture.native.host, "delete").mockImplementation(
    async (id, revision) => {
      await held.promise;
      if (!nativeDelete) throw new Error("fixture delete");
      return nativeDelete(id, revision);
    },
  );
  try {
    // A native command acquires busy synchronously before React can rerender.
    // The open confirmation must check the controller again at submission.
    const removal = fixture.control.delete?.("fixture-agent", 1);
    expect(fixture.control.snapshot().busy).toBe(true);
    fireEvent.click(confirm);
    await act(async () => {});
    expect(fixture.signedBy).toEqual([]);
    expect(fixture.published).toEqual([]);
    await act(async () => {
      held.release();
      await removal;
    });
  } finally {
    held.release();
  }
});
it("a cached loaded roster that still lists the agent does not veto a relay-confirmed removal", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  const { outbox, workSessions } = fixture.instance.session;
  // The loaded row's live update never arrived: it still lists the agent.
  const stale = {
    list: () => ({ channels: [{ id: room, members: [agent.pubkey] }] }),
  };
  await removeAgentFromChannels(
    { outbox, workSessions, channels: stale } as unknown as Parameters<
      typeof removeAgentFromChannels
    >[0],
    agent.pubkey,
    new AbortController().signal,
  );
  expect(fixture.published.map((event) => event.kind)).toEqual([9001]);
  expect(fixture.channels).toEqual({ [room]: [] });
});
it("a channel whose fresh roster cannot be read stays unconfirmed", async () => {
  const fixture = mountManaged(viewer, true, { [room]: [agent.pubkey] });
  const { outbox, workSessions } = fixture.instance.session;
  const loaded = {
    list: () => ({ channels: [{ id: hidden, members: [agent.pubkey] }] }),
  };
  // The relay serves no roster for the loaded channel to this viewer.
  const query = fixture.transport.query;
  fixture.transport.query = async (filters, ...rest) =>
    (await query(filters, ...rest)).filter(
      (event) =>
        !event.tags.some(([name, id]) => name === "d" && id === hidden),
    );
  await expect(
    removeAgentFromChannels(
      { outbox, workSessions, channels: loaded } as unknown as Parameters<
        typeof removeAgentFromChannels
      >[0],
      agent.pubkey,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Could not refresh channel membership. Retry to continue.");
});
it("Delete re-reads archive state instead of trusting a cached archived identity", async () => {
  const fixture = mountManaged();
  fixture.archiveExternally(agent.pubkey);
  await act(() => fixture.instance.session.archives.refresh());
  expect(
    await screen.findByRole("button", { name: "Unarchive agent" }),
  ).toBeVisible();
  // Another client unarchives it; this session's cache still says archived.
  fixture.unarchiveExternally(agent.pubkey);
  const archivedAtNativeDelete: boolean[] = [];
  const nativeDelete = fixture.native.host.delete?.bind(fixture.native.host);
  vi.spyOn(fixture.native.host, "delete").mockImplementation(
    async (id, revision) => {
      archivedAtNativeDelete.push(fixture.archived.has(agent.pubkey));
      if (!nativeDelete) throw new Error("fixture delete");
      return nativeDelete(id, revision);
    },
  );
  await confirmDelete(userEvent.setup());
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.published.map((event) => event.kind)).toEqual([9035]);
  expect(archivedAtNativeDelete).toEqual([true]);
});
it("a deployed remote record native cannot delete gets no delete action", async () => {
  const { native, control } = managed();
  native.agent.deployedRemote = true;
  const fixture = mountWith(
    archiveRelay(
      viewer,
      relay,
      [attested(viewer)],
      {},
      {
        [room]: [agent.pubkey],
      },
    ),
    control,
  );
  expect(
    await screen.findByRole("button", { name: "Archive agent" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Delete agent" })).toBeNull();
  expect(fixture.published).toEqual([]);
  expect(native.calls.some((call) => call.action === "delete")).toBe(false);
});
it("closing the profile during Delete's fresh archive read starts no archive request", async () => {
  const fixture = mountManaged();
  await screen.findByRole("button", { name: "Delete agent" });
  const held = deferred();
  let reading = false;
  const query = fixture.transport.query;
  fixture.transport.query = async (filters, ...rest) => {
    if (filters.some((filter) => filter.kinds?.includes(13535))) {
      reading = true;
      await held.promise;
    }
    return query(filters, ...rest);
  };
  await confirmDelete(userEvent.setup());
  await vi.waitFor(() => expect(reading).toBe(true));
  cleanup();
  held.release();
  // Delete awaits this same read first, so its continuation has run by now.
  await fixture.instance.session.archives.ensure();
  await act(async () => {});
  expect(fixture.signedBy).toEqual([]);
  expect(fixture.published).toEqual([]);
  expect(deletes(fixture)).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
});
it("closing the profile while the outbox hydrates admits no channel removal", async () => {
  const hydration = deferred();
  const fixture = mountManaged(
    viewer,
    true,
    { [room]: [agent.pubkey] },
    async () => {
      await hydration.promise;
      return [];
    },
  );
  let discovered = false;
  const query = fixture.transport.query;
  fixture.transport.query = async (filters, ...rest) => {
    const events = await query(filters, ...rest);
    if (filters.some((filter) => filter["#p"]?.includes(agent.pubkey)))
      discovered = true;
    return events;
  };
  await confirmDelete(userEvent.setup());
  await vi.waitFor(() => expect(discovered).toBe(true));
  await act(async () => {});
  cleanup();
  hydration.release();
  const outbox = fixture.instance.session.outbox;
  // Delete awaited readiness first, so its continuation has run by now.
  await outbox?.ready();
  expect(outbox?.snapshot()).toEqual([]);
  expect(fixture.published).toEqual([]);
  expect(deletes(fixture)).toEqual([]);
  expect(fixture.close).not.toHaveBeenCalled();
});
it("a relay admin may archive but not delete another owner's agent", async () => {
  const { native, control } = managed();
  mountWith(
    archiveRelay(viewer, relay, [attested(stranger)], {
      [viewer.pubkey]: "admin",
    }),
    control,
  );
  expect(
    await screen.findByRole("button", { name: "Archive agent" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Delete agent" })).toBeNull();
  expect(native.calls.some((call) => call.action === "delete")).toBe(false);
});
