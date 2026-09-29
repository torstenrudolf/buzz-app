// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunityMembership } from "../bundled/moderation/membership";
import {
  SettingsCardsService,
  type SettingsCard,
  type SettingsCards,
} from "../features/settings/service";
import type { RelayData } from "../features/relay/service";
import type { Contribution } from "../plugins/contributions";

afterEach(cleanup);

function registry(initial: Contribution<SettingsCard>[]) {
  let entries: readonly Contribution<SettingsCard>[] = initial;
  const listeners = new Set<() => void>();
  const cards: SettingsCards = {
    snapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register() {},
    retainVisibility: () => () => {},
    visibility: (key) => entries.some((entry) => entry.key === key),
  };
  return {
    cards,
    set(next: Contribution<SettingsCard>[]) {
      entries = next;
      for (const listener of listeners) listener();
    },
  };
}
const card = (
  id: string,
  title: string,
  group?: string,
  section?: "administration",
): Contribution<SettingsCard> =>
  Object.freeze({
    id,
    title,
    ...(group ? { group } : {}),
    ...(section ? { section } : {}),
    key: `example/${id}`,
    pluginId: "example",
    revision: "one",
    component: ({ community }) => (
      <p>
        {title} body{community ? ` for ${community.name}` : ""}
      </p>
    ),
  });
// Built-in sections have their own tests; this file covers plugin card placement.
for (const [path, name] of [
  ["./NotificationSettings", "NotificationSettings"],
  ["./AppearanceSettings", "AppearanceSettings"],
  ["./ShortcutSettings", "ShortcutSettings"],
  ["./ProfileSettings", "ProfileSettings"],
  ["./AgentSettings", "AgentSettings"],
  ["./DeveloperSettings", "DeveloperSettings"],
  ["../features/updates/UpdateSettings", "UpdateSettings"],
] as const)
  vi.doMock(path, () => ({ [name]: () => null }));
const { Settings } = await import("./Settings");
const pluginState = {
  configuration: { status: "loading" },
  activation: {},
  busy: false,
  error: null,
  refreshError: null,
};
const communityState = {
  status: "ready",
  viewer: "ab".repeat(32),
  profile: { name: "Buzz User", picture: "" },
  memberships: [{ id: "primary", name: "Primary" }],
  selected: "primary",
};
const host = {
  plugins: { subscribe: () => () => {}, snapshot: () => pluginState },
  communities: {
    subscribe: () => () => {},
    snapshot: () => communityState,
  },
} as unknown as Parameters<typeof Settings>[0];

it("keeps grouped cards available without a selected community", () => {
  const { cards } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const noCommunityState = { ...communityState, selected: null };
  render(
    <Settings
      {...host}
      communities={
        {
          subscribe: () => () => {},
          snapshot: () => noCommunityState,
        } as unknown as Parameters<typeof Settings>[0]["communities"]
      }
      cards={cards}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Communities");
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Personal groups" })).toBeNull();
});

it("shows administration only within a selected community", () => {
  const membership = card(
    "membership",
    "Membership",
    undefined,
    "administration",
  );
  const { cards } = registry([membership]);
  const view = render(<Settings {...host} cards={cards} />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Primary");
  expect(nav).toHaveTextContent("Administration");
  fireEvent.click(screen.getByRole("button", { name: "Membership" }));
  expect(screen.getByText("Membership body for Primary")).toBeVisible();

  const noCommunityState = { ...communityState, selected: null };
  const noCommunity = {
    subscribe: () => () => {},
    snapshot: () => noCommunityState,
  } as unknown as Parameters<typeof Settings>[0]["communities"];
  view.rerender(<Settings {...host} communities={noCommunity} cards={cards} />);
  expect(nav).not.toHaveTextContent("Administration");
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByText("Membership body")).toBeNull();
});

it("gives contributed cards their own community sections and retires removed cards", async () => {
  const { cards, set } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const complete = vi.fn(() => true);
  const onSection = vi.fn();
  render(
    <Settings
      {...host}
      cards={cards}
      navigation={
        {
          target: {
            version: 1,
            kind: "settings",
            section: "example/hosted",
          },
          complete,
        } as never
      }
      onSection={onSection}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Primary");
  expect(nav).toHaveTextContent("Communities");
  expect(await screen.findByText("Hosted communities body")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText("Personal groups body")).toBeNull();
  expect(complete).toHaveBeenLastCalledWith({ status: "opened" });

  act(() => set([card("groups", "Personal groups")]));
  await waitFor(() => expect(onSection).toHaveBeenLastCalledWith("profile"));
  expect(screen.queryByText("Hosted communities body")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(nav).not.toHaveTextContent("Hosted communities");
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
});

it("keeps same-id community cards from different plugins distinct", () => {
  const { cards } = registry([
    card("groups", "Example groups"),
    {
      ...card("groups", "Other groups"),
      key: "other/groups",
      pluginId: "other",
    },
  ]);
  render(<Settings {...host} cards={cards} />);
  fireEvent.click(screen.getByRole("button", { name: "Other groups" }));
  expect(screen.getByText("Other groups body for Primary")).toBeVisible();
  expect(screen.queryByText("Example groups body for Primary")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Example groups" }),
  ).not.toHaveAttribute("aria-current");
});

it("keeps Administration hidden after applying a verified ordinary-member roster", async () => {
  const viewer = "a".repeat(64);
  const relayAuthor = "f".repeat(64);
  let resolveRoster!: (events: unknown[]) => void;
  const roster = new Promise<unknown[]>((resolve) => {
    resolveRoster = resolve;
  });
  const membership = createCommunityMembership({
    snapshot: () => ({
      status: "ready",
      generation: 1,
      scope: `https://primary.example:${viewer}`,
      viewer,
      session: {
        relayAuthor,
        read: () => roster,
        profiles: { ensure: vi.fn(async () => {}) },
      },
    }),
    subscribe: () => () => {},
  } as unknown as RelayData);
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  const scope = root.extend({
    pluginOwner: { id: "moderation", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    ctx.settingsCards.register({
      id: "membership",
      title: "Membership",
      section: "administration",
      visibility: {
        snapshot: () => {
          const state = membership.snapshot();
          return (
            state.status === "ready" &&
            (state.role === "owner" || state.role === "admin")
          );
        },
        subscribe: membership.subscribe,
        ensure: membership.ensure,
      },
      component: () => <p>Membership body</p>,
    });
  });
  await fiber.await();
  render(<Settings {...host} cards={cards} />);
  expect(membership.snapshot().status).toBe("loading");

  resolveRoster([
    {
      id: "1".repeat(64),
      kind: 13534,
      pubkey: relayAuthor,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["member", viewer, "member"]],
    },
  ]);
  await waitFor(() =>
    expect(membership.snapshot()).toMatchObject({
      status: "ready",
      role: "member",
      refreshing: false,
    }),
  );

  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).not.toHaveTextContent("Administration");
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  await fiber.dispose();
  membership.dispose();
  await root.fiber.dispose();
});
