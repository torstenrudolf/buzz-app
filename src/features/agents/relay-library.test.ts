import { expect, it, vi } from "vitest";
import { keypair, signed } from "../relay/testing";
import {
  definitionSlug,
  isOwnerInventoryFilter,
  readRelayLibrary,
} from "./relay-library";
import { createAgentLibrary } from "./library";
import type { RelayEvent } from "../relay/events";

const owner = keypair();
const record = (kind: number, d: string, body: unknown, created_at = 1) =>
  signed(owner, {
    kind,
    tags: [["d", d]],
    content: JSON.stringify(body),
    created_at,
  });
const signal = () => new AbortController().signal;

it("discovers remote-only identities, joins explicit profile references and ignores malformed latest heads", async () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  const read = vi.fn().mockResolvedValue([
    record(30175, "builtin-fizz", {
      display_name: "Fizz",
      avatar_url: "https://example.com/art.png",
      system_prompt: "not projected",
    }),
    record(30175, "unused", { display_name: "Fizz" }),
    record(30177, a, {
      name: "Fizz",
      persona_id: "builtin:fizz",
      private_key: "not projected",
    }),
    record(30177, b, { name: "Fizz", persona_id: "builtin:fizz" }),
    record(30177, c, { name: "Unlinked" }),
    record(30177, "d".repeat(64), { name: "Old" }),
    record(30177, "d".repeat(64), null, 2),
    record(30177, "not-a-key", { name: "Invalid" }),
    record(30175, "../invalid", { display_name: "Invalid" }),
  ]);
  const library = await readRelayLibrary({ read }, owner.pubkey, signal());
  expect(library.identities.map((row) => row.pubkey)).toEqual([a, b, c]);
  expect(library.identities[0]).toEqual({
    pubkey: a,
    name: "Fizz",
    definitionId: "builtin-fizz",
    avatar: "https://example.com/art.png",
  });
  expect(JSON.stringify(library)).not.toContain("not projected");
  expect(library.identities[1]?.definitionId).toBe("builtin-fizz");
  expect(library.identities[2]?.definitionId).toBeUndefined();
});

it("uses the publisher's slug grammar, not display-name matching", () => {
  expect(definitionSlug("builtin:honey")).toBe("builtin-honey");
  expect(definitionSlug("CodeReviewer")).toBe("codereviewer");
  expect(definitionSlug("_ops")).toBe("a_ops");
  expect(definitionSlug("A😀B")).toBe("a-b");
  expect(definitionSlug("a".repeat(65))).toHaveLength(64);
});

it("paginates same-second boundaries with composite cursors and fails on non-progress", async () => {
  // Pagination is the behavior under test: fill exactly one 200-event page.
  const page = Array.from({ length: 200 }, (_, i) =>
    record(30177, i.toString(16).padStart(64, "0"), { name: `Agent ${i}` }),
  );
  page.sort((a, b) => a.id.localeCompare(b.id));
  const read = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce([]);
  expect(
    (await readRelayLibrary({ read }, owner.pubkey, signal())).identities,
  ).toHaveLength(200);
  expect(read.mock.calls[1]?.[0][0]).toMatchObject({
    until: 1,
    before_id: page.at(-1)?.id,
    authors: [owner.pubkey],
  });
  read.mockReset().mockResolvedValue(page);
  await expect(
    readRelayLibrary({ read }, owner.pubkey, signal()),
  ).rejects.toThrow("did not advance");
});

it("rejects another owner's response, retries failure, replaces deletions and fences cancelled reads", async () => {
  const read = vi.fn().mockResolvedValue([
    signed(keypair(), {
      kind: 30177,
      tags: [["d", "a".repeat(64)]],
      content: '{"name":"Foreign"}',
    }),
  ]);
  const library = createAgentLibrary((abort) =>
    readRelayLibrary({ read }, owner.pubkey, abort),
  );
  await library.queries.refresh();
  expect(library.queries.snapshot().status).toBe("error");
  expect(library.queries.snapshot().identities).toEqual([]);
  read.mockResolvedValue([record(30177, "a".repeat(64), { name: "Here" })]);
  await library.queries.refresh();
  expect(library.queries.snapshot().identities).toHaveLength(1);
  // Relay applies coordinate deletions; a fresh complete snapshot replaces old rows.
  read.mockResolvedValue([]);
  await library.queries.refresh();
  expect(library.queries.snapshot().identities).toEqual([]);
  let release!: (events: RelayEvent[]) => void;
  read.mockImplementation(
    () =>
      new Promise<RelayEvent[]>((resolve) => {
        release = resolve;
      }),
  );
  const pending = library.queries.refresh();
  await vi.waitFor(() => expect(release).toBeDefined());
  library.clear();
  release([record(30177, "b".repeat(64), { name: "Late" })]);
  await pending;
  expect(library.queries.snapshot().status).toBe("idle");
  expect(library.queries.snapshot().identities).toEqual([]);
  library.dispose();
});

it("uses the lowest event ID for equal-time coordinate replacements", async () => {
  const rows = [
    record(30177, "a".repeat(64), { name: "First" }),
    record(30177, "a".repeat(64), { name: "Second" }),
  ];
  const winner = [...rows].sort((a, b) => a.id.localeCompare(b.id))[0];
  const read = vi.fn().mockResolvedValue(rows);
  const library = await readRelayLibrary({ read }, owner.pubkey, signal());
  expect(library.identities[0]?.name).toBe(
    JSON.parse(winner?.content ?? "{}").name,
  );
  read.mockResolvedValue([...rows].reverse());
  expect(await readRelayLibrary({ read }, owner.pubkey, signal())).toEqual(
    library,
  );
});

it("trims projected profile and identity names without changing signed evidence or internal spaces", async () => {
  const events = [
    record(30175, "larry", { display_name: " \tLarry  Profile\n" }),
    record(30177, "a".repeat(64), {
      name: "\n Larry  Agent \t",
      persona_id: "larry",
    }),
    record(30175, "blank", { display_name: " \t\n" }),
    record(30177, "b".repeat(64), { name: " \t\n" }),
  ];
  const evidence = JSON.stringify(events);
  const library = await readRelayLibrary(
    { read: vi.fn().mockResolvedValue(events) },
    owner.pubkey,
    signal(),
  );
  expect(library.definitions).toEqual([
    { id: "larry", name: "Larry  Profile" },
  ]);
  expect(library.identities).toEqual([
    { pubkey: "a".repeat(64), name: "Larry  Agent", definitionId: "larry" },
  ]);
  expect(JSON.stringify(events)).toBe(evidence);
});

it("recognizes only the owner-scoped inventory read as access-independent", () => {
  const me = owner.pubkey;
  const page = { kinds: [30175, 30177], authors: [me], limit: 200 };
  expect(isOwnerInventoryFilter(page, me)).toBe(true);
  expect(
    isOwnerInventoryFilter({ ...page, until: 5, before_id: "e" }, me),
  ).toBe(true);
  expect(isOwnerInventoryFilter(page, undefined)).toBe(false);
  expect(
    isOwnerInventoryFilter({ ...page, authors: ["f".repeat(64)] }, me),
  ).toBe(false);
  expect(
    isOwnerInventoryFilter({ ...page, authors: [me, "f".repeat(64)] }, me),
  ).toBe(false);
  expect(isOwnerInventoryFilter({ ...page, kinds: [30177, 9] }, me)).toBe(
    false,
  );
  expect(isOwnerInventoryFilter({ ...page, kinds: [] }, me)).toBe(false);
  expect(isOwnerInventoryFilter({ ...page, "#h": ["c"] }, me)).toBe(false);
});
