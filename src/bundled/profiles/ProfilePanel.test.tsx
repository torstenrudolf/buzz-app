// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import userEvent from "@testing-library/user-event";
import { createAgentActivity } from "../../features/agents/activity";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

import { agentDirectory } from "../../features/identity-names/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { keypair, profile } from "../../features/relay/testing";

const key = "a".repeat(64);
afterEach(cleanup);
it("updates a mounted profile from the shared name view without replacing its identity", async () => {
  let name = "Local name";
  let notify = () => {};
  const owner = createRelaySession(null, {
    identityNames: {
      register() {},
      bind(source) {
        return bindNames(source, {
          snapshot: () => [
            {
              id: "test",
              activate() {
                return undefined;
              },
              scope: () => () => ({ name }),
            },
          ],
          subscribe(listener) {
            notify = listener;
            return () => {};
          },
        });
      },
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    const presenceStatus = vi
      .spyOn(owner.session.presence, "status")
      .mockReturnValue("online");
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(key) ?? ""}
        close={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    expect(
      screen.getAllByRole("img", { name: "Presence: Active" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("img", { name: `${name} avatar, online` }),
    ).toBeNull();
    expect(document.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Channels" }));
    expect(
      screen.getByRole("img", { name: `${name} avatar, online` }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(
      screen.getAllByRole("img", { name: "Presence: Active" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("img", { name: `${name} avatar, online` }),
    ).toBeNull();
    act(() => {
      name = "Edited name";
      notify();
    });
    expect(screen.getByRole("heading", { name })).toBeTruthy();
    presenceStatus.mockReturnValue("unknown");
    act(() => {
      name = "Unknown status name";
      notify();
    });
    expect(screen.getByRole("img", { name: `${name} avatar` })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(document.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
      "data-status",
    );
    expect(owner.session.profiles.snapshot().size).toBe(0);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("recovers provider-owned names in the same live session and releases demand when disabled", async () => {
  const person = keypair();
  const relayKey = keypair();
  const publicProfile = profile(person, { name: "Public Carl" });
  let live!: LiveCallbacks;
  let entries = [agentDirectory];
  let changed = () => {};
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey: person.pubkey, name: "Configured Carl" }],
  }));
  const owner = createRelaySession(
    {
      viewer: person.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "wss://relay.example.test",
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(0))
          ? [publicProfile]
          : [],
      media: () => undefined,
      readAgentLibrary: read,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind(source) {
          return bindNames(source, {
            snapshot: () => entries,
            subscribe(listener) {
              changed = listener;
              return () => {};
            },
          });
        },
      },
    },
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const reconnect = () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
  };
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(person.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Configured Carl" });
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(person.pubkey)?.name).toBe(
        "Public Carl",
      ),
    );
    act(() => live.state({ status: "connected", routes: [] }));
    act(() => live.state({ status: "retrying", routes: [] }));
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
    expect(read).toHaveBeenCalledTimes(1);
    act(() => {
      live.state({ status: "connected", routes: [] });
      live.established();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    act(() => {
      entries = [];
      changed();
      reconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    act(() => {
      entries = [agentDirectory];
      changed();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(3);
    owner.dispose();
    act(reconnect);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it.each(["action", "initial read"])(
  "Info gives %s failures one recovery owner",
  async (failure) => {
    const fixture = controlFixture();
    const person = keypair();
    const owner = createRelaySession({
      viewer: key,
      relayAuthor: keypair().pubkey,
      media: () => undefined,
      query: async () => [
        profile(person, { name: "Owned agent", is_agent: true }),
      ],
    });
    const control = createAgentControl(fixture.host);
    const snapshot = {
      status: "ready" as const,
      generation: 1,
      scope: `https://relay.example.test:${key}`,
      viewer: key,
      session: owner.session,
    };
    const relay: RelayData = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      clearCache: async () => {},
    };
    // Seed a known-agent hint; authority still comes only from the native snapshot.
    fixture.agent.pubkey = person.pubkey;
    await owner.session.profiles.ensure([person.pubkey]);
    if (failure === "initial read")
      vi.spyOn(fixture.host, "snapshot").mockRejectedValueOnce(
        "snapshot rejected",
      );
    else
      vi.spyOn(fixture.host, "action").mockRejectedValueOnce("stop rejected");
    const user = userEvent.setup();
    try {
      render(
        <ProfilePanel
          relay={relay}
          control={control}
          target={profileTarget(person.pubkey) ?? ""}
          close={() => {}}
        />,
      );
      if (failure === "action")
        await user.click(await screen.findByRole("button", { name: "Stop" }));
      await screen.findByText(
        failure === "action"
          ? /stop rejected/
          : /Could not refresh local agents/,
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "Retry agents" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Retry status" }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole("region", { name: "Instances" }),
      ).toHaveTextContent(fixture.agent.name);
      expect(screen.getByRole("button", { name: "Stop" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    } finally {
      cleanup();
      control.dispose();
      owner.dispose();
    }
  },
);

it("offers the activity preview to known agents only, never to people", async () => {
  const person = keypair();
  const agent = keypair();
  const localAgent = keypair();
  const activity = createAgentActivity(true, vi.fn(), () => true);
  const owner = createRelaySession({
    viewer: key,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      profile(person, { name: "Plain person" }),
      profile(agent, { name: "Declared agent", is_agent: true }),
      profile(localAgent, { name: "Local agent" }),
    ],
    readAgentLibrary: async () => ({
      definitions: [],
      identities: [{ pubkey: localAgent.pubkey, name: "Local agent" }],
    }),
  });
  const release = activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.example.test:${key}`,
    viewer: key,
    session: { ...owner.session, agentActivity: activity.queries },
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const context = {
    channelId: "channel-a",
    canOpen: () => true,
    open: () => true,
  };
  const view = (pubkey: string) => (
    <ProfilePanel
      relay={relay}
      target={profileTarget(pubkey) ?? ""}
      context={context}
      close={() => {}}
    />
  );
  try {
    const mounted = render(view(person.pubkey));
    // The settled metadata read is the barrier: no agent evidence can follow it.
    await screen.findByRole("heading", { name: "Plain person" });
    expect(
      screen.queryByRole("region", { name: "Activity preview" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View activity" }),
    ).not.toBeInTheDocument();
    mounted.rerender(view(agent.pubkey));
    await screen.findByRole("heading", { name: "Declared agent" });
    expect(
      await screen.findByRole("region", { name: "Activity preview" }),
    ).toHaveTextContent("No activity yet");
    expect(screen.getByRole("button", { name: "View activity" })).toBeEnabled();
    mounted.rerender(view(localAgent.pubkey));
    await screen.findByRole("heading", { name: "Local agent" });
    await act(() => owner.session.agentChoices.refresh());
    expect(owner.session.agentChoices.snapshot().identities).toEqual([
      expect.objectContaining({ pubkey: localAgent.pubkey }),
    ]);
    expect(
      owner.session.profiles.snapshot().get(localAgent.pubkey)?.isAgent,
    ).not.toBe(true);
    expect(
      await screen.findByRole("region", { name: "Activity preview" }),
    ).toHaveTextContent("No activity yet");
    expect(screen.getByRole("button", { name: "View activity" })).toBeEnabled();
  } finally {
    cleanup();
    release();
    activity.dispose();
    owner.dispose();
  }
});

it.each(["ambiguous", "unmatched"])(
  "Info retains recovery for a known %s identity",
  async (kind) => {
    const fixture = controlFixture();
    const person = keypair();
    const owner = createRelaySession({
      viewer: key,
      relayAuthor: keypair().pubkey,
      media: () => undefined,
      query: async () => [
        profile(person, { name: "Known agent", is_agent: true }),
      ],
    });
    if (kind === "ambiguous") {
      fixture.agent.pubkey = person.pubkey;
      fixture.data.agents.push({ ...fixture.agent, id: "duplicate" });
    }
    await owner.session.profiles.ensure([person.pubkey]);
    const control = createAgentControl(fixture.host);
    const snapshot = {
      status: "ready" as const,
      generation: 1,
      scope: `https://relay.example.test:${key}`,
      viewer: key,
      session: owner.session,
    };
    const relay: RelayData = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      clearCache: async () => {},
    };
    try {
      render(
        <ProfilePanel
          relay={relay}
          control={control}
          target={profileTarget(person.pubkey) ?? ""}
          close={() => {}}
        />,
      );
      await waitFor(() => expect(control.snapshot().status).toBe("ready"));
      vi.spyOn(fixture.host, "snapshot").mockRejectedValueOnce("read failed");
      await act(() => control.refresh());
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Managed agent status is unconfirmed.",
      );
      expect(
        screen.queryByRole("region", { name: "Local agent actions" }),
      ).not.toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Retry agents" }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole("region", { name: "Instances" }),
      ).toBeInTheDocument();
    } finally {
      cleanup();
      control.dispose();
      owner.dispose();
    }
  },
);

it("exposes thinking in Profile Info while its identity artwork is decorative", async () => {
  const agent = keypair();
  const owner = createRelaySession({
    viewer: key,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      profile(agent, { name: "Thinking agent", is_agent: true }),
    ],
  });
  await owner.session.profiles.ensure([agent.pubkey]);
  vi.spyOn(owner.session.presence, "status").mockReturnValue("online");
  let activity = owner.session.agentActivity.snapshot();
  const listeners = new Set<() => void>();
  const session = {
    ...owner.session,
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => activity,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Thinking agent" }),
    ).toBeTruthy();
    const details = screen.getByRole("region", { name: "Profile details" });
    expect(details).not.toHaveAccessibleDescription();
    expect(document.querySelector(".agent-motion-avatar")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    act(() => {
      activity = {
        ...activity,
        turns: [
          {
            agent: agent.pubkey,
            channelId: "alpha",
            turnId: "one",
            timestamp: 0,
            state: "working",
          },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(details).toHaveAccessibleDescription("Agent is thinking");
    expect(screen.getByRole("img", { name: "Presence: Active" })).toBeTruthy();
    act(() => {
      activity = { ...activity, turns: [] };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
  } finally {
    cleanup();
    owner.dispose();
  }
});
