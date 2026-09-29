// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { allowedActions, membersFromSnapshot } from "./api";
import { CommunityAdmin } from "./CommunityAdmin";

const relayKey = "f".repeat(64);
const owner = "0".repeat(64);
const admin = "1".repeat(64);
const member = "2".repeat(64);
const snapshot = (tags: string[][], pubkey = relayKey) => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey,
  created_at: 1,
  content: "",
  sig: "",
  tags,
});
const roster = [
  ["-"],
  ["member", owner, "owner"],
  ["member", admin, "admin"],
  ["member", member, "member"],
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads roles only from the relay-signed member list", () => {
  expect(membersFromSnapshot(snapshot(roster), relayKey)).toEqual([
    { pubkey: owner, role: "owner" },
    { pubkey: admin, role: "admin" },
    { pubkey: member, role: "member" },
  ]);
  expect(() =>
    membersFromSnapshot(snapshot(roster, owner), relayKey),
  ).toThrow();
  expect(
    membersFromSnapshot(
      snapshot([
        ["p", admin, "", "owner"],
        ["member", "A".repeat(64), "owner"],
      ]),
      relayKey,
    ),
  ).toEqual([]);
});

it("offers only actions the relay permission matrix allows", () => {
  const m = (role: "owner" | "admin" | "member") => ({ pubkey: member, role });
  expect(allowedActions("owner", m("member"), false)).toEqual([
    "promote",
    "remove",
  ]);
  expect(allowedActions("owner", m("admin"), false)).toEqual([
    "demote",
    "remove",
  ]);
  expect(allowedActions("owner", m("owner"), false)).toEqual([]);
  expect(allowedActions("owner", m("admin"), true)).toEqual([]);
  expect(allowedActions("admin", m("member"), false)).toEqual(["remove"]);
  expect(allowedActions("admin", m("admin"), false)).toEqual([]);
  expect(allowedActions("member", m("member"), false)).toEqual([]);
  expect(allowedActions(undefined, m("member"), false)).toEqual([]);
});

function relay(
  viewer: string,
  events = [snapshot(roster)],
  profiles = new Map<string, { name: string }>(),
  people: { pubkey: string; name: string }[] = [],
) {
  const read = vi.fn(async () => events);
  const session = {
    relayAuthor: relayKey,
    read,
    viewer,
    media: () => undefined,
    directMessages: {
      people: async () => ({ people, hasMore: false }),
    },
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: async () => {},
    },
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session,
  };
  return {
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

function broker(routes: Record<string, (body: unknown) => Response>) {
  const calls: { route: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).split("/").at(-1) ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ route, body });
      if (route === "session") return Response.json({ relayAuthor: relayKey });
      return routes[route]?.(body) ?? Response.json({}, { status: 404 });
    }),
  );
  return calls;
}

it("gates administration to owners and admins by the verified roster", async () => {
  broker({});
  const { relay: data, read } = relay(member);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(
    await screen.findByText(
      "Only community owners and admins can invite people or manage members.",
    ),
  ).toBeVisible();
  expect(read).toHaveBeenCalledWith(
    [{ kinds: [13534], authors: [relayKey], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull();
});

it("treats a roster signed by anyone else as unavailable", async () => {
  broker({});
  const { relay: data } = relay(owner, [snapshot(roster, owner)]);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load members",
  );
});

it("mints a bounded invite and surfaces relay refusals", async () => {
  const user = userEvent.setup();
  let refuse = false;
  const calls = broker({
    invite: (body) =>
      refuse
        ? Response.json(
            { error: "only relay owners and admins can create invites" },
            { status: 403 },
          )
        : Response.json({
            code: "abc",
            url: "https://primary.example/invite/abc",
            expires_at: 1700003600,
            max_uses: (body as { max_uses: number | null }).max_uses,
            uses_remaining: (body as { max_uses: number | null }).max_uses,
          }),
  });
  const { relay: data } = relay(admin);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(
    await screen.findByRole("button", { name: "Invite members" }),
  );
  // Opening the dialog creates the link with the default settings.
  expect(
    await screen.findByDisplayValue("https://primary.example/invite/abc"),
  ).toBeVisible();
  expect(calls.filter((c) => c.route === "invite")).toEqual([
    { route: "invite", body: { ttl_secs: 3 * 24 * 60 * 60, max_uses: null } },
  ]);
  // Admins cannot grant admin, so direct addition has no role choice.
  await user.type(
    screen.getByRole("textbox", { name: "Public identity" }),
    "3".repeat(64),
  );
  expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Choose member role" }),
  ).toBeNull();
  refuse = true;
  await user.click(
    screen.getByRole("button", { name: "Choose maximum invite uses" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "1 use" }));
  expect(screen.queryByRole("menuitemradio")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "only relay owners and admins can create invites",
    ),
  );
  expect(calls.filter((c) => c.route === "invite").at(-1)?.body).toEqual({
    ttl_secs: 3 * 24 * 60 * 60,
    max_uses: 1,
  });
  expect(
    screen.queryByDisplayValue("https://primary.example/invite/abc"),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

it("confirms member removal and shows the relay's refusal", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () =>
      Response.json(
        { error: "invalid: cannot remove the relay owner" },
        { status: 400 },
      ),
  });
  const { relay: data } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(
    screen.queryByRole("button", { name: `Actions for ${owner.slice(0, 8)}` }),
  ).toBeNull();
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  expect(menus).toHaveLength(2); // Admin and member; never the viewer/owner.
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  expect(calls.some((c) => c.route === "member")).toBe(false);
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "invalid: cannot remove the relay owner",
    ),
  );
  expect(calls.find((c) => c.route === "member")?.body).toEqual({
    action: "remove",
    pubkey: member,
  });
});

it("keeps an accepted removal when the refresh fails and retries read-only", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
  });
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  read.mockRejectedValueOnce(new Error("relay unavailable"));
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  expect(
    await screen.findByText("Change accepted by the relay."),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not load members: relay unavailable The list below may be out of date.",
  );
  // A stale list offers no further destructive commands.
  expect(screen.queryAllByRole("button", { name: /^Actions for / })).toEqual(
    [],
  );
  expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull();
  read.mockResolvedValueOnce([
    snapshot([
      ["member", owner, "owner"],
      ["member", admin, "admin"],
    ]),
  ]);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(
    1,
  );
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
});

it("picks up a promotion made elsewhere when refreshed", async () => {
  const user = userEvent.setup();
  broker({});
  const { relay: data, read } = relay(member);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByText(
    "Only community owners and admins can invite people or manage members.",
  );
  read.mockResolvedValueOnce([
    snapshot([
      ["member", owner, "owner"],
      ["member", member, "admin"],
    ]),
  ]);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByRole("button", { name: "Invite members" }),
  ).toBeVisible();
});

it("recovers from an initial read failure on retry", async () => {
  const user = userEvent.setup();
  broker({});
  const { relay: data, read } = relay(owner);
  read.mockRejectedValueOnce(new Error("offline"));
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load members: offline",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Invite members" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("disables an open confirmation when a pending refresh fails", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
  });
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Remove" });
  expect(confirm).toBeEnabled();
  const held = deferred<ReturnType<typeof snapshot>[]>();
  read.mockReturnValueOnce(held.promise);
  // Refresh stays reachable behind the modal in the browser; drive it directly.
  screen.getByRole("button", { name: "Refresh", hidden: true }).click();
  await waitFor(() => expect(confirm).toBeDisabled());
  held.reject(new Error("relay unavailable"));
  expect(
    await within(dialog).findByText(
      "The member list is out of date. Retry before making changes.",
    ),
  ).toBeVisible();
  expect(confirm).toBeDisabled();
  confirm.click();
  await Promise.resolve();
  expect(calls.filter((c) => c.route === "member")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(calls.filter((c) => c.route === "member")).toHaveLength(0);
});

it("locks an open invite dialog after an accepted add whose refresh fails", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
    invite: () =>
      Response.json({
        code: "abc",
        url: "https://primary.example/invite/abc",
        expires_at: 1700003600,
        max_uses: null,
        uses_remaining: null,
      }),
  });
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(
    await screen.findByRole("button", { name: "Invite members" }),
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByDisplayValue("https://primary.example/invite/abc");
  read.mockRejectedValueOnce(new Error("relay unavailable"));
  // The field resets after a confirmed direct addition.
  const search = () =>
    within(dialog).getByRole("textbox", {
      name: "Public identity",
    });
  await user.type(search(), "3".repeat(64));
  await user.click(within(dialog).getByRole("button", { name: "Add member" }));
  expect(
    await within(dialog).findByText("Member added directly."),
  ).toBeVisible();
  expect(
    await within(dialog).findByText(
      "The member list is out of date. Retry before making changes.",
    ),
  ).toBeVisible();
  await user.type(search(), "4".repeat(64));
  expect(
    within(dialog).getByRole("button", { name: "Add member" }),
  ).toBeDisabled();
  expect(
    within(dialog).getByRole("button", { name: "Choose maximum invite uses" }),
  ).toBeDisabled();
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
  expect(calls.filter((c) => c.route === "invite")).toHaveLength(1);
  // Read-only recovery inside the modal re-enables new writes.
  await user.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Add member" }),
    ).toBeEnabled(),
  );
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
  // Recovery keeps the existing link rather than minting another.
  expect(calls.filter((c) => c.route === "invite")).toHaveLength(1);
});

it.each([
  ["equal", "Bob"],
  ["visually identical", "Bob\u200B"],
])(
  "qualifies %s namesakes through roster actions, confirmation and the write",
  async (_, nameB) => {
    const user = userEvent.setup();
    const bobA = "a".repeat(64);
    const bobB = "b".repeat(64);
    const calls = broker({
      member: () => Response.json({ accepted: true, message: "" }),
    });
    const { relay: data } = relay(
      owner,
      [
        snapshot([
          ["member", owner, "owner"],
          ["member", bobA, "member"],
          ["member", bobB, "member"],
        ]),
      ],
      new Map([
        [bobA, { name: "Bob" }],
        [bobB, { name: nameB }],
      ]),
    );
    render(<CommunityAdmin relay={data} active={() => true} />);
    const keys = publicKeyLabels([owner, bobA, bobB]);
    const labelB = `${nameB} · ${keys.get(bobB)}`;
    expect(keys.get(bobA)).not.toBe(keys.get(bobB));
    expect(
      await screen.findByRole("button", {
        name: `Actions for Bob · ${keys.get(bobA)}`,
      }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: `Actions for ${labelB}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Make admin" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`Make admin: ${labelB}?`);
    await user.click(
      within(dialog).getByRole("button", { name: "Make admin" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.route === "member")?.body).toEqual({
        action: "role",
        pubkey: bobB,
        role: "admin",
      }),
    );
  },
);

it("accepts only an exact identity and never searches the people directory", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
    invite: () =>
      Response.json({
        code: "abc",
        url: "https://primary.example/invite/abc",
        expires_at: 1700003600,
        max_uses: null,
        uses_remaining: null,
      }),
  });
  const people = vi.fn(async () => ({ people: [], hasMore: false }));
  const { relay: data } = relay(owner);
  (
    data.snapshot().session.directMessages as unknown as {
      people: typeof people;
    }
  ).people = people;
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(
    await screen.findByRole("button", { name: "Invite members" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Add or invite people",
  });
  const identity = within(dialog).getByRole("textbox", {
    name: "Public identity",
  });
  const add = within(dialog).getByRole("button", { name: "Add member" });
  await user.type(identity, "Carol");
  expect(add).toBeDisabled();
  expect(people).not.toHaveBeenCalled();
  await user.clear(identity);
  await user.type(identity, "c".repeat(64));
  expect(add).toBeEnabled();
  await user.click(add);
  await waitFor(() =>
    expect(calls.find((call) => call.route === "member")?.body).toEqual({
      action: "add",
      pubkey: "c".repeat(64),
      role: "member",
    }),
  );
  expect(people).not.toHaveBeenCalled();
});
