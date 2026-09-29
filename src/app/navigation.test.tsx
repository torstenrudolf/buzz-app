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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../features/relay/testing";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";
import type { RelayEvent } from "../features/relay/events";
import type { Context } from "@deepseek-ai/cordis";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

const activation = vi.hoisted(() => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
});
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.moderation", name: "Moderation", apiVersion: 1 },
      module: await import("../bundled/moderation"),
    },
    {
      manifest: { id: "test.gated", name: "Gated", apiVersion: 1 },
      module: {
        inject: ["settingsCards"],
        async apply(ctx: Context) {
          await activation.held;
          ctx.settingsCards.register({
            id: "card",
            title: "Gated card",
            group: "Communities",
            component: () => <p>Gated card body</p>,
          });
        },
      },
    },
  ],
}));
// jsdom has no media queries; responsive geometry is covered in browser tests.
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  activation.release();
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("waits for a starting plugin before opening its addressed Settings card", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = { version: 1, kind: "settings", section: "test.gated/card" };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  try {
    await waitFor(() =>
      expect(current.plugins.snapshot().activation["test.gated"]?.status).toBe(
        "starting",
      ),
    );
    expect(current.navigation.snapshot().status).not.toBe("failed");
    expect(
      screen.queryByText("This destination couldn’t open"),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => activation.release());
  }
  expect(await screen.findByText("Gated card body")).toBeVisible();
  expect(current.navigation.snapshot().status).toBe("opened");
});

const viewer = keypair();
const authority = keypair();
const primary = "https://membership-a.example";
const secondary = "https://membership-b.example";
const membershipTarget = {
  version: 1 as const,
  kind: "settings" as const,
  section: "buzz.moderation/membership",
  scope: { viewer: viewer.pubkey, communityOrigin: primary },
};
function membershipFixture() {
  stubAvatarBrowserApis();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer.pubkey}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [
        { id: primary, name: "Primary" },
        { id: secondary, name: "Secondary" },
      ],
      selected: secondary,
    }),
  );
  let respond: () => Promise<Response> = async () => Response.json([]);
  const rosterReads: string[] = [];
  let offline = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity"))
        return Response.json({ viewer: viewer.pubkey });
      const community = decodeURIComponent(url.split("/").at(-2) ?? "");
      if (url.endsWith("/session")) {
        if (offline)
          return Response.json({ error: "offline" }, { status: 503 });
        return Response.json({
          viewer: viewer.pubkey,
          relayAuthor: authority.pubkey,
          relayUrl: community,
        });
      }
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body));
        if (
          filters.some((filter: { kinds?: number[] }) =>
            filter.kinds?.includes(13534),
          )
        ) {
          rosterReads.push(community);
          return respond();
        }
        return Response.json([]);
      }
      return Response.json({});
    }),
  );
  const roster = (role: string): RelayEvent =>
    signed(authority, {
      kind: 13534,
      content: "",
      tags: [["member", viewer.pubkey, role]],
    });
  return {
    rosterReads,
    offline(value = true) {
      offline = value;
    },
    hold() {
      let release!: (role: string) => void;
      const response = new Promise<string>((resolve) => {
        release = resolve;
      });
      respond = async () => Response.json([roster(await response)]);
      return (role = "owner") => release(role);
    },
    fail() {
      respond = async () =>
        Response.json({ error: "offline" }, { status: 503 });
    },
    owner() {
      respond = async () => Response.json([roster("owner")]);
    },
  };
}
function restoreMembership() {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(membershipTarget))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}
function expectPending(current: AppServices) {
  expect(current.navigation.snapshot().status).toBe("opening");
  expect(screen.getByText("Opening destination…")).toBeVisible();
  expect(screen.queryByText("This destination couldn’t open")).toBeNull();
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Profile" })).toBeNull();
}
it("restores a scoped Membership URL only after its verified roster is applied", async () => {
  const fixture = membershipFixture();
  const release = fixture.hold();
  const current = restoreMembership();
  try {
    await waitFor(() => expect(fixture.rosterReads).toContain(primary));
    expect(current.communities.snapshot().selected).toBe(primary);
    expectPending(current);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("heading", { name: "Membership" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});
it("reselects and reauthorizes Membership when Back returns from another community", async () => {
  const fixture = membershipFixture();
  fixture.owner();
  const current = restoreMembership();
  await screen.findByRole("heading", { name: "Membership" });
  await act(async () => {
    current.communities.select(secondary);
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
      scope: { viewer: viewer.pubkey, communityOrigin: secondary },
    });
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  const before = fixture.rosterReads.length;
  const release = fixture.hold();
  try {
    act(() => current.navigation.back());
    await waitFor(() =>
      expect(fixture.rosterReads.length).toBeGreaterThan(before),
    );
    expect(current.communities.snapshot().selected).toBe(primary);
    expectPending(current);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("heading", { name: "Membership" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});
it("fails a completed ordinary-member read without exposing Membership", async () => {
  const fixture = membershipFixture();
  const release = fixture.hold();
  const current = restoreMembership();
  try {
    await waitFor(() => expect(fixture.rosterReads).toContain(primary));
  } finally {
    await act(async () => release("member"));
  }
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("failed"),
  );
  expect(screen.getByText("This destination couldn’t open")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Membership" })).toBeNull();
});
it("Retry navigation starts a fresh permission read after a failed roster", async () => {
  const fixture = membershipFixture();
  fixture.fail();
  const current = restoreMembership();
  await screen.findByRole("button", { name: "Retry navigation" });
  const before = fixture.rosterReads.length;
  expect(before).toBeGreaterThan(0);
  const release = fixture.hold();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry navigation" }));
    await waitFor(() =>
      expect(fixture.rosterReads.length).toBeGreaterThan(before),
    );
    expectPending(current);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("heading", { name: "Membership" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});

it("reconnects the selected Membership community after its transport fails", async () => {
  const fixture = membershipFixture();
  fixture.offline();
  fixture.owner();
  const current = restoreMembership();
  await screen.findByRole("button", { name: "Retry navigation" });
  expect(current.communities.snapshot().selected).toBe(primary);
  expect(current.relay.snapshot().status).toBe("error");
  const retry = vi.spyOn(current.relay, "retry");
  fixture.offline(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry navigation" }));
  await screen.findByRole("heading", { name: "Membership" });
  expect(retry).toHaveBeenCalledOnce();
  expect(current.navigation.snapshot().status).toBe("opened");
});
it("does not reconnect an unrelated community when the addressed Settings scope is denied", async () => {
  const fixture = membershipFixture();
  fixture.offline();
  const current = restoreMembership();
  await screen.findByRole("button", { name: "Retry navigation" });
  const retry = vi.spyOn(current.relay, "retry");
  act(() => {
    void current.navigation.open({
      ...membershipTarget,
      scope: { viewer: authority.pubkey, communityOrigin: primary },
    });
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().reason).toBe("denied"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry navigation" }));
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("failed"),
  );
  expect(current.navigation.snapshot().reason).toBe("denied");
  expect(retry).not.toHaveBeenCalled();
});
