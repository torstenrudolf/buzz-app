// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { npubEncode } from "nostr-tools/nip19";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile, roster, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelMembersButton } from "./ChannelMembersDialog";
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
});
async function setup(
  type = "stream",
  missingNames = false,
  localAgent = false,
) {
  const fixture = controlFixture();
  fixture.agent.status = "stopped";
  const control = createAgentControl(fixture.host);
  await control.refresh();
  stops.push(control.dispose);
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const target = localAgent ? fixture.agent.pubkey : person.pubkey;
  const members = [viewer.pubkey];
  let clock = 1700000000;
  let failure = "";
  let applyAddition = true;
  let searchFailure = false;
  let nameRetry: Promise<void> | undefined;
  let rosterRead: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const publish = vi.fn(async (_event: RelayEvent) => {
    if (failure) throw new PublishRejected(failure);
    if (release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (applyAddition) members.push(target);
    clock++;
  });
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (filters.some((filter) => filter.search)) {
      if (searchFailure) throw new Error("Search offline");
      return [profile(person, { name: "Morgan" })];
    }
    if (
      missingNames &&
      filters.some(
        (filter) =>
          filter.kinds?.includes(0) && filter.authors?.includes(viewer.pubkey),
      )
    ) {
      await nameRetry;
      throw new Error("Names unavailable");
    }
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      await rosterRead;
    return [
      roster(relay, id, members, clock),
      signed(relay, {
        kind: 39000,
        content: "",
        tags: [["d", id], ["t", type], ["private"], ["name", "Design"]],
      }),
      profile(viewer, { name: "Carl" }),
      profile(person, { name: "Morgan" }),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter)));
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query,
      readAgentLibrary: async () => ({ definitions: [], identities: [] }),
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      agentChoices: control,
    },
  );
  stops.push(owner.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  render(
    <ToastProvider>
      <ChannelMembersButton
        session={owner.session}
        channelId={id}
        control={control}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Channel members" }));
  if (missingNames) await screen.findByText(/Some names could not load/);
  else await screen.findByText("Carl (you)");
  return {
    user,
    fixture,
    control,
    dispose: owner.dispose,
    publish,
    query,
    session: owner.session,
    person,
    viewer,
    delayRoster: () => {
      applyAddition = false;
    },
    confirmRoster: () => {
      members.push(target);
      clock++;
    },
    removeTarget: () => {
      members.splice(members.indexOf(target), 1);
      clock++;
    },
    fail: (value: string) => {
      failure = value;
    },
    holdRoster: (pending: Promise<void> | undefined) => {
      rosterRead = pending;
    },
    holdNames: (pending: Promise<void>) => {
      nameRetry = pending;
    },
    failSearch: () => {
      searchFailure = true;
    },
    hold: () => {
      release = () => {};
    },
    release: () => release?.(),
    async search() {
      await user.type(
        screen.getByRole("searchbox"),
        localAgent ? "Fixture agent" : "Morgan",
      );
      return screen.findByRole("button", {
        name: localAgent ? /Add Fixture agent/ : /Add Morgan/,
      });
    },
  };
}
it("searches outside the roster, prevents double submission, and moves confirmed additions into Members", async () => {
  const t = await setup();
  const add = await t.search();
  t.hold();
  await t.user.click(add);
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  expect(add).toHaveAttribute("aria-disabled", "true");
  await t.user.click(add);
  expect(t.publish).toHaveBeenCalledOnce();
  await act(async () => t.release());
  await screen.findByText("Morgan is in the channel.");
  expect(
    screen.queryByRole("button", { name: /Add Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.person.pubkey,
  );
});
it("shows the real rejection and retries without discarding the query", async () => {
  const t = await setup();
  t.fail("Only the owner can add this agent");
  await t.user.click(await t.search());
  await screen.findByText(/Only the owner/);
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  t.fail("");
  await t.user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Morgan is in the channel.");
});
it("DMs are view-only and never search outside their members", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  expect(
    screen.getByText("DM membership cannot be changed here."),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Not in this channel" }),
  ).not.toBeInTheDocument();
  expect(
    t.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter.search),
    ),
  ).toBe(false);
});
it("Escape closes the dialog and restores focus to its header button", async () => {
  const t = await setup();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Channel members" })).toHaveFocus();
});
it("failed directory searches show retry, not a false empty result", async () => {
  const t = await setup();
  t.failSearch();
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const section = screen.getByRole("region", { name: "Not in this channel" });
  await within(section).findByRole("button", { name: "Retry search" });
  expect(
    within(section).queryByText("No other matching people or agents."),
  ).not.toBeInTheDocument();
});

it("finds an existing member by their canonical public key", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), npubEncode(t.viewer.pubkey));
  expect(screen.getByText("Carl (you)")).toBeVisible();
});

it("optional member-name failure does not block a verified addition", async () => {
  const t = await setup("stream", true);
  const add = await t.search();
  expect(add).toBeEnabled();
  await t.user.click(add);
  await screen.findByText("Morgan is in the channel.");
  expect(t.publish).toHaveBeenCalledOnce();
});

it.each(["pending", "failed"])(
  "retrying optional names keeps Add usable while names are %s without refreshing membership",
  async (state) => {
    const t = await setup("stream", true);
    const add = await t.search();
    await vi.waitFor(() => expect(add).toBeEnabled());
    const rosterReads = () =>
      t.query.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39002)),
      ).length;
    const nameReads = () =>
      t.query.mock.calls.filter(([filters]) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(0) &&
            filter.authors?.includes(t.viewer.pubkey),
        ),
      ).length;
    const beforeRoster = rosterReads();
    const beforeNames = nameReads();
    let release!: () => void;
    t.holdNames(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      await t.user.click(screen.getByRole("button", { name: "Retry names" }));
      await vi.waitFor(() => expect(nameReads()).toBe(beforeNames + 1));
      expect(rosterReads()).toBe(beforeRoster);
      expect(add).toBeEnabled();
      expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
      if (state === "failed") {
        await act(async () => release());
        await screen.findByText(/Some names could not load/);
        expect(rosterReads()).toBe(beforeRoster);
        expect(add).toBeEnabled();
      }
      await t.user.click(add);
      await screen.findByText("Morgan is in the channel.");
      expect(t.publish).toHaveBeenCalledOnce();
    } finally {
      await act(async () => release());
    }
  },
);

it("finishes confirmed local-agent startup after closing and reopening during publication", async () => {
  const t = await setup("stream", false, true);
  t.hold();
  await t.user.click(await t.search());
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  const preview = screen.getByRole("dialog", {
    name: "Fixture agent identity",
  });
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() => expect(preview).not.toBeInTheDocument());
  expect(screen.getByRole("dialog", { name: "Channel members" })).toBeVisible();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await t.search();
  expect(screen.getByText("Adding…")).toBeVisible();
  await act(async () => t.release());
  await vi.waitFor(() =>
    expect(t.control.snapshot().data?.agents[0]?.status).toBe("running"),
  );
  expect(t.publish).toHaveBeenCalledOnce();
  expect(
    t.fixture.calls.filter((call) => call.action === "start"),
  ).toHaveLength(1);
});

it("keeps closed-dialog startup failures recoverable without another membership write", async () => {
  const t = await setup("stream", false, true);
  const action = t.fixture.host.action;
  vi.spyOn(t.fixture.host, "action")
    .mockRejectedValueOnce(new Error("Missing credentials"))
    .mockImplementation(action);
  t.hold();
  await t.user.click(await t.search());
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  const preview = screen.getByRole("dialog", {
    name: "Fixture agent identity",
  });
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() => expect(preview).not.toBeInTheDocument());
  expect(screen.getByRole("dialog", { name: "Channel members" })).toBeVisible();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await act(async () => t.release());
  await vi.waitFor(() =>
    expect(t.session.memberAdditions.snapshot()[0]?.error).toContain(
      "agent did not start",
    ),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText(/Added to the channel, but the agent did not start/);
  await t.user.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(t.control.snapshot().data?.agents[0]?.status).toBe("running"),
  );
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.session.memberAdditions.snapshot()).toEqual([]);
});

it("does not start the agent after its relay session is disposed", async () => {
  const t = await setup("stream", false, true);
  t.hold();
  await t.user.click(await t.search());
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  cleanup();
  await act(async () => t.dispose());
  await act(async () => t.release());
  expect(t.fixture.calls.some((call) => call.action === "start")).toBe(false);
});

it.each(["none", "rejected", "lagging"])(
  "requires explicit re-add after remote removal, preserving retry identity (%s)",
  async (failure) => {
    const rejectReadd = failure === "rejected";
    const t = await setup("stream", false, true);
    const action = vi
      .spyOn(t.fixture.host, "action")
      .mockRejectedValueOnce(new Error("Missing credentials"));
    await t.user.click(await t.search());
    await screen.findByText(/agent did not start/);
    await t.user.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await t.user.click(screen.getByRole("button", { name: "Channel members" }));
    await screen.findByText(/agent did not start/);
    await vi.waitFor(() =>
      expect(screen.queryByText("Loading members…")).not.toBeInTheDocument(),
    );
    // Change relay evidence only: the cached roster still contains this agent.
    t.removeTarget();
    expect(t.session.channels.list().channels[0]?.members).toContain(
      t.fixture.agent.pubkey,
    );
    await t.user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Membership changed/);
    expect(action).toHaveBeenCalledOnce();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.session.channels.list().channels[0]?.members).not.toContain(
      t.fixture.agent.pubkey,
    );
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    if (rejectReadd) t.fail("Addition denied");
    if (failure === "lagging") t.delayRoster();
    await t.user.click(await t.search());
    if (rejectReadd) {
      await screen.findByText(/Addition denied/);
      t.fail("");
      await t.user.click(screen.getByRole("button", { name: "Retry" }));
    }
    if (failure === "lagging") {
      await screen.findByText(/Addition is not confirmed/);
      await t.user.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText(/Addition is not confirmed/);
      expect(t.publish).toHaveBeenCalledTimes(2);
      t.confirmRoster();
      await t.user.click(screen.getByRole("button", { name: "Retry" }));
    }
    await vi.waitFor(() =>
      expect(t.control.snapshot().data?.agents[0]?.status).toBe("running"),
    );
    expect(t.publish).toHaveBeenCalledTimes(rejectReadd ? 3 : 2);
    const ids = t.publish.mock.calls.map(([event]) => event.id);
    expect(ids[0]).not.toBe(ids[1]);
    if (rejectReadd) expect(ids[1]).toBe(ids[2]);
    expect(action).toHaveBeenCalledTimes(2);
  },
);

it("keeps known members quiet while rechecking membership without enabling unverified additions", async () => {
  const t = await setup();
  await vi.waitFor(() =>
    expect(screen.queryByText("Loading members…")).toBeNull(),
  );
  expect(await t.search()).toBeEnabled();
  await t.user.keyboard("{Escape}");
  const rosterReads = () =>
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39002)),
    ).length;
  const before = rosterReads();
  let release!: () => void;
  t.holdRoster(
    new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error("Roster unavailable"));
    }),
  );
  try {
    await t.user.click(screen.getByRole("button", { name: "Channel members" }));
    await vi.waitFor(() => expect(rosterReads()).toBe(before + 1));
    expect(screen.getByText("Carl (you)")).toBeVisible();
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    const add = await t.search();
    expect(add).toBeDisabled();
    // No matching members is not an empty roster.
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    await act(async () => release());
    const retry = await screen.findByRole("button", { name: "Retry members" });
    expect(add).toBeDisabled();
    t.holdRoster(undefined);
    await t.user.click(retry);
    await vi.waitFor(() => expect(add).toBeEnabled());
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    await act(async () => release());
  }
});
