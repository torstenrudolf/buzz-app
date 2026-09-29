// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { HostedCommunities } from "./HostedCommunities";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const local = "a".repeat(64);
const other = "b".repeat(64);
type Handler = (body: Record<string, string>) => unknown;
let routes: Record<string, Handler>;
let calls: [string, Record<string, string>][];

beforeEach(() => {
  calls = [];
  routes = {
    "/api/relay/identity": () => ({ viewer: local }),
    "/api/builderlab/auth": () => ({
      auth: { email: "a@example.com", name: "Ada", expiresAt: "2030" },
    }),
    "/api/builderlab/identity": () => ({ identity: { pubkey_hex: local } }),
    "/api/builderlab/list": () => ({ communities: [] }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push([url, body]);
      const handler = routes[url];
      return handler
        ? Response.json(await handler(body))
        : Response.json({ error: "missing" }, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
// The dev app renders under StrictMode, which remounts effects once.
const renderCard = () =>
  render(
    <StrictMode>
      <HostedCommunities active={() => true} />
    </StrictMode>,
  );

it("reads the packaged local identity from the native host without contacting the broker", async () => {
  const { isTauri } = await import("@tauri-apps/api/core");
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.mocked(invoke).mockResolvedValue(local);
  try {
    renderCard();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("identity_restore"),
    );
    expect(calls.map(([url]) => url)).not.toContain("/api/relay/identity");
  } finally {
    vi.mocked(isTauri).mockReturnValue(false);
    vi.unstubAllEnvs();
  }
});

it("offers browser sign-in when no Builderlab session exists", async () => {
  routes["/api/builderlab/auth"] = () => ({ auth: null });
  renderCard();
  expect(
    await screen.findByRole("button", { name: /Sign in with Builderlab/ }),
  ).toBeEnabled();
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/list");
});

it("connects the Buzz identity when the account has none", async () => {
  routes["/api/builderlab/identity"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  renderCard();
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Buzz identity" }),
  );
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  expect(await screen.findByText(npubEncode(local))).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("pauses create and offers a switch when the account uses another identity", async () => {
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  routes["/api/builderlab/unbind"] = () => ({});
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  renderCard();
  const region = await screen.findByRole("region", {
    name: "Identity mismatch",
  });
  expect(region).toHaveTextContent(npubEncode(other));
  expect(region).toHaveTextContent(npubEncode(local));
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Switch to this device’s identity" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Identity mismatch" }),
    ).not.toBeInTheDocument(),
  );
  const order = calls.map(([url]) => url);
  expect(order.indexOf("/api/builderlab/unbind")).toBeLessThan(
    order.indexOf("/api/builderlab/bind"),
  );
});

it("checks availability after a pause and creates a valid community", async () => {
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () => ({
    community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
  });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCard();
  const input = await screen.findByPlaceholderText("north-star");
  await waitFor(() => expect(input).toBeEnabled());
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "North" } });
  expect(input).toHaveValue("north");
  expect(input).toHaveAccessibleDescription(".communities.buzz.xyz");
  fireEvent.change(input, { target: { value: "-north" } });
  expect(input).toHaveAccessibleDescription(
    ".communities.buzz.xyz Use lowercase letters, numbers, and single hyphens.",
  );
  fireEvent.change(input, { target: { value: "North" } });
  expect(calls.map(([url]) => url)).not.toContain(
    "/api/builderlab/availability",
  );
  await act(() => vi.advanceTimersByTimeAsync(500));
  vi.useRealTimers();
  expect(
    await screen.findByText("That address is available."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("wss://north.communities.buzz.xyz"),
  );
  expect(calls).toContainEqual(["/api/builderlab/create", { name: "north" }]);
  expect(await screen.findByText(/Add a community/)).toBeInTheDocument();
});

it("rejects invalid names and blocks create at the community limit", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: Array.from({ length: 5 }, (_, index) => ({
      id: `c${index}`,
      name: `c${index}`,
      normalized_host: `c${index}.communities.buzz.xyz`,
    })),
  });
  renderCard();
  expect(await screen.findByText("5 of 5 used")).toBeInTheDocument();
  expect(screen.getByText(/reached the limit of 5/)).toBeInTheDocument();
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
});

it("archives and transfers after confirmation, surfacing friendly errors", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [
      {
        id: "c1",
        name: "north",
        normalized_host: "north.communities.buzz.xyz",
      },
    ],
  });
  routes["/api/builderlab/archive"] = () => ({
    community: { id: "c1", archived_at: "2026-09-24" },
  });
  routes["/api/builderlab/transfer"] = () => ({
    error: { code: "transferee_not_registered" },
    correlation_id: "corr-1",
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive",
    }),
  );
  await waitFor(() =>
    expect(calls).toContainEqual([
      "/api/builderlab/archive",
      { community_id: "c1" },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
  const recipient = npubEncode(other);
  fireEvent.change(screen.getByPlaceholderText("npub1…"), {
    target: { value: recipient },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That person needs a connected Buzz identity before you can transfer ownership to them. Correlation ID: corr-1",
  );
  expect(calls).toContainEqual([
    "/api/builderlab/transfer",
    { communityId: "c1", transfereeNpub: recipient },
  ]);
});

/** A route answer the test releases by hand. */
function hold() {
  let release!: (value: unknown) => void;
  const answer = new Promise((resolve) => {
    release = resolve;
  });
  return { answer: () => answer, release };
}

it("keeps create and copy paused until this device's key is read and matches", async () => {
  const device = hold();
  routes["/api/relay/identity"] = device.answer as Handler;
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/list"] = () => ({
    communities: [
      {
        id: "c1",
        name: "north",
        normalized_host: "north.communities.buzz.xyz",
      },
    ],
  });
  renderCard();
  expect(
    await screen.findByText("Checking this device’s Buzz identity…"),
  ).toBeInTheDocument();
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Copy address" }),
  ).not.toBeInTheDocument();
  await act(async () => device.release({ viewer: other }));
  expect(
    await screen.findByRole("region", { name: "Identity mismatch" }),
  ).toHaveTextContent(
    "Your Builderlab account is linked to another Buzz key. Creating communities and copying addresses are paused until the identities match.",
  );
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
});

it("pauses actions with a retry when this device's key cannot be read", async () => {
  routes["/api/relay/identity"] = () => {
    throw new Error("offline");
  };
  renderCard();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read this device’s Buzz identity",
  );
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  routes["/api/relay/identity"] = () => ({ viewer: local });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(npubEncode(local))).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByPlaceholderText("north-star")).toBeEnabled(),
  );
});

it("ignores an older load that finishes after a newer identity change", async () => {
  const stale = hold();
  let first = true;
  routes["/api/builderlab/identity"] = () => {
    if (first) {
      first = false;
      return stale.answer();
    }
    return { identity: { pubkey_hex: local } };
  };
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  renderCard();
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Buzz identity" }),
  );
  expect(await screen.findByText(npubEncode(local))).toBeInTheDocument();
  // The initial read, begun before Connect, reports an older binding.
  await act(async () => stale.release({ identity: { pubkey_hex: other } }));
  expect(
    screen.queryByRole("region", { name: "Identity mismatch" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(npubEncode(local))).toBeInTheDocument();
});

it("does not bind after the card is deactivated during Switch", async () => {
  const unbind = hold();
  let live = true;
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  routes["/api/builderlab/unbind"] = unbind.answer as Handler;
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  render(<HostedCommunities active={() => live} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Switch to this device’s identity",
    }),
  );
  await waitFor(() =>
    expect(calls.map(([url]) => url)).toContain("/api/builderlab/unbind"),
  );
  live = false;
  await act(async () => unbind.release({}));
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/bind");
  expect(
    screen.getByRole("button", { name: "Connect Buzz identity" }),
  ).toBeInTheDocument();
});

async function typeName(value: string) {
  const input = await screen.findByPlaceholderText("north-star");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value } });
}

it("shows an availability failure and retries the same name", async () => {
  routes["/api/builderlab/availability"] = () => ({
    error: { code: "relay_unavailable" },
    correlation_id: "corr-2",
  });
  renderCard();
  await typeName("north");
  expect(
    await screen.findByRole("alert", {}, { timeout: 2000 }),
  ).toHaveTextContent(
    "Community provisioning is temporarily unavailable. Correlation ID: corr-2",
  );
  expect(screen.queryByText("Checking availability…")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toBeDisabled();
  routes["/api/builderlab/availability"] = () => ({ available: true });
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(
    await screen.findByText(
      "That address is available.",
      {},
      { timeout: 2000 },
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toBeEnabled();
});

it("keeps the address visible when the clipboard rejects", async () => {
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () => ({
    community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
  });
  const writeText = vi.fn(async (_: string): Promise<void> => {
    throw new Error("denied");
  });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCard();
  await typeName("north");
  await screen.findByText("That address is available.", {}, { timeout: 2000 });
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t copy the address.",
  );
  expect(
    screen.getByText("wss://north.communities.buzz.xyz"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Address copied/)).not.toBeInTheDocument();
  writeText.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Try copying again" }));
  expect(await screen.findByText(/Address copied/)).toBeInTheDocument();
});

it.each([
  ["an app-shell page", () => new Response("<!doctype html>", { status: 200 })],
  ["a missing route", () => new Response("Not found", { status: 404 })],
])(
  "reports hosted communities as unavailable when auth returns %s",
  async (_, reply) => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "/api/builderlab/auth" ? reply() : base(url, init),
      ),
    );
    renderCard();
    expect(
      await screen.findByText(/need the Buzz development broker/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking sign-in…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign in with Builderlab/ }),
    ).not.toBeInTheDocument();
  },
);

const listed = {
  communities: [
    { id: "c1", name: "north", normalized_host: "north.communities.buzz.xyz" },
  ],
};

it("drops a failed copy handoff when the identity is unpaired", async () => {
  routes["/api/builderlab/list"] = () => listed;
  routes["/api/builderlab/unbind"] = () => ({});
  const writeText = vi.fn(async (_: string): Promise<void> => {
    throw new Error("denied");
  });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));
  expect(
    await screen.findByRole("button", { name: "Try copying again" }),
  ).toBeEnabled();
  routes["/api/builderlab/identity"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  fireEvent.click(screen.getByRole("button", { name: "Unpair identity" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Unpair identity",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Connect Buzz identity" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Try copying again" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("wss://north.communities.buzz.xyz"),
  ).not.toBeInTheDocument();
  expect(writeText).toHaveBeenCalledTimes(1);
});

it("does not carry a failed copy handoff into the next sign-in", async () => {
  routes["/api/builderlab/list"] = () => listed;
  routes["/api/builderlab/sign-out"] = () => ({});
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));
  await screen.findByRole("button", { name: "Try copying again" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  routes["/api/builderlab/login"] = () => ({
    auth: { email: "b@example.com", name: "Bea", expiresAt: "2030" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /Sign in with Builderlab/ }),
  );
  expect(await screen.findByText("Bea")).toBeInTheDocument();
  await screen.findByRole("button", { name: "Copy address" });
  expect(
    screen.queryByRole("button", { name: "Try copying again" }),
  ).not.toBeInTheDocument();
});

it("does not write to the clipboard when create finishes after the card retires", async () => {
  const create = hold();
  let live = true;
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = create.answer as Handler;
  const writeText = vi.fn(async (_: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<HostedCommunities active={() => live} />);
  await typeName("north");
  await screen.findByText("That address is available.", {}, { timeout: 2000 });
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  await waitFor(() =>
    expect(calls.map(([url]) => url)).toContain("/api/builderlab/create"),
  );
  live = false;
  await act(async () =>
    create.release({
      community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
    }),
  );
  expect(writeText).not.toHaveBeenCalled();
});

it("keeps a created community's address when the following refresh fails", async () => {
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () => ({
    community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  await typeName("north");
  await screen.findByText("That address is available.", {}, { timeout: 2000 });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "relay_unavailable" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  expect(
    await screen.findByText(/The change was saved, but the list could not/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("wss://north.communities.buzz.xyz"),
  ).toBeInTheDocument();
  // The name is cleared, so the same create cannot be resubmitted by accident.
  expect(screen.getByPlaceholderText("north-star")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toBeDisabled();
  routes["/api/builderlab/list"] = () => listed;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("1 of 5 used")).toBeInTheDocument();
  expect(screen.queryByText(/The change was saved/)).not.toBeInTheDocument();
  expect(
    calls.filter(([url]) => url === "/api/builderlab/create"),
  ).toHaveLength(1);
});

it("completes a transfer when the following refresh fails", async () => {
  routes["/api/builderlab/list"] = () => listed;
  routes["/api/builderlab/transfer"] = () => ({
    community: { id: "c1" },
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Transfer" }));
  fireEvent.change(screen.getByPlaceholderText("npub1…"), {
    target: { value: npubEncode(other) },
  });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "relay_unavailable" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  expect(
    await screen.findByText(/The change was saved, but the list could not/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The transferred row is no longer offered as owned.
  expect(screen.queryByText("north")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Transfer" }),
  ).not.toBeInTheDocument();
  routes["/api/builderlab/list"] = () => ({ communities: [] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("0 of 5 used")).toBeInTheDocument();
  expect(
    calls.filter(([url]) => url === "/api/builderlab/transfer"),
  ).toHaveLength(1);
});

it.each([
  ["archive", "Archive", "Unarchive", null, "2026-09-24"],
  ["unarchive", "Unarchive", "Archive", "2026-09-24", null],
] as const)(
  "applies a confirmed %s when the following refresh fails",
  async (kind, action, next, before, after) => {
    const row = (archived_at: string | null) => ({
      communities: [{ ...listed.communities[0], archived_at }],
    });
    routes["/api/builderlab/list"] = () => row(before);
    routes[`/api/builderlab/${kind}`] = () => ({
      community: { id: "c1", archived_at: after },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: action }));
    routes["/api/builderlab/list"] = () => ({
      error: { code: "relay_unavailable" },
    });
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: action,
      }),
    );
    expect(
      await screen.findByText(/The change was saved, but the list could not/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: next })).toBeEnabled(),
    );
    expect(
      screen.queryByRole("button", { name: action }),
    ).not.toBeInTheDocument();
    // Copy is offered only for an active community.
    expect(
      Boolean(screen.queryByRole("button", { name: "Copy address" })),
    ).toBe(kind === "unarchive");
    routes["/api/builderlab/list"] = () => row(after);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/The change was saved/),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: next })).toBeEnabled();
    expect(
      calls.filter(([url]) => url === `/api/builderlab/${kind}`),
    ).toHaveLength(1);
  },
);

const unbound = () => ({
  error: { code: "missing_mapping", setup_needed: true },
});
const different = () => ({ identity: { pubkey_hex: other } });

it.each([
  ["completed rejection", "unbound", unbound],
  ["completed rejection", "a different identity", different],
  ["late success", "unbound", unbound],
  ["late success", "a different identity", different],
  ["late rejection", "unbound", unbound],
  ["late rejection", "a different identity", different],
])(
  "drops a %s copy handoff when Refresh finds the account %s",
  async (schedule, _, identity) => {
    routes["/api/builderlab/list"] = () => listed;
    const clipboard = hold();
    const writeText = vi.fn(async (_: string) => {
      if (schedule === "completed rejection") throw new Error("denied");
      if ((await clipboard.answer()) === "reject") throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy address" }),
    );
    if (schedule === "completed rejection")
      await screen.findByRole("button", { name: "Try copying again" });
    else await waitFor(() => expect(writeText).toHaveBeenCalled());
    // Another window or device changes the account's identity.
    routes["/api/builderlab/identity"] = identity;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByRole("button", {
        name:
          identity === unbound
            ? "Connect Buzz identity"
            : "Switch to this device’s identity",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    await act(async () =>
      clipboard.release(schedule === "late success" ? "resolve" : "reject"),
    );
    expect(screen.queryByText(/Address copied/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("wss://north.communities.buzz.xyz"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try copying again" }),
    ).not.toBeInTheDocument();
  },
);

it("keeps a failed copy handoff across a same-identity refresh", async () => {
  routes["/api/builderlab/list"] = () => listed;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));
  await screen.findByRole("button", { name: "Try copying again" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  expect(
    screen.getByText("wss://north.communities.buzz.xyz"),
  ).toBeInTheDocument();
});

it.each([
  ["completed rejection", "fails"],
  ["completed rejection", "succeeds"],
  ["late success", "fails"],
  ["late success", "succeeds"],
  ["late rejection", "fails"],
  ["late rejection", "succeeds"],
])(
  "drops a %s copy handoff when the community is archived and the refresh %s",
  async (schedule, refresh) => {
    routes["/api/builderlab/list"] = () => listed;
    routes["/api/builderlab/archive"] = () => ({
      community: { id: "c1", archived_at: "2026-09-24" },
    });
    const clipboard = hold();
    const writeText = vi.fn(async (_: string) => {
      if (schedule === "completed rejection") throw new Error("denied");
      if ((await clipboard.answer()) === "reject") throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy address" }),
    );
    if (schedule === "completed rejection")
      await screen.findByRole("button", { name: "Try copying again" });
    else await waitFor(() => expect(writeText).toHaveBeenCalled());
    routes["/api/builderlab/list"] =
      refresh === "fails"
        ? () => ({ error: { code: "relay_unavailable" } })
        : () => ({
            communities: [
              { ...listed.communities[0], archived_at: "2026-09-24" },
            ],
          });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unarchive" })).toBeEnabled(),
    );
    await act(async () =>
      clipboard.release(schedule === "late success" ? "resolve" : "reject"),
    );
    expect(screen.queryByText(/Address copied/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("wss://north.communities.buzz.xyz"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try copying again" }),
    ).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
  },
);

it("keeps a failed copy handoff for another address when a community is archived", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [
      ...listed.communities,
      {
        id: "c2",
        name: "south",
        normalized_host: "south.communities.buzz.xyz",
      },
    ],
  });
  routes["/api/builderlab/archive"] = () => ({
    community: { id: "c1", archived_at: "2026-09-24" },
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  const [, south] = await screen.findAllByRole("button", {
    name: "Copy address",
  });
  fireEvent.click(south as HTMLElement);
  await screen.findByRole("button", { name: "Try copying again" });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "relay_unavailable" },
  });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Archive" })[0] as HTMLElement,
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeEnabled(),
  );
  expect(
    screen.getByText("wss://south.communities.buzz.xyz"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Try copying again" }),
  ).toBeEnabled();
});
