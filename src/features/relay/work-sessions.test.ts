import { expect, it, vi } from "vitest";
import { SESSION_CHANNEL_DESCRIPTION } from "../sessions/metadata";
import { createWorkSessions } from "./work-sessions";
import type { Outbox, OutgoingEvent } from "./outbox";
import type { ChannelQueries } from "./contracts";
import {
  keypair,
  message,
  metadata,
  roster,
  flush,
  scriptedTransport,
  signed,
} from "./testing";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { canAddMembers } from "../channel-members/members";
const event = message(keypair(), "session", "Work", 1);

it("keeps verified session roster reads available for sends without member-add capability", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const current = roster(relay, id, [viewer.pubkey]);
  const query = vi.fn(
    async (filters: readonly { kinds?: readonly number[] }[]) =>
      filters.some((filter) => filter.kinds?.includes(39000))
        ? [
            current,
            signed(relay, {
              kind: 39000,
              content: "",
              tags: [
                ["d", id],
                ["t", "stream"],
                ["private"],
                ["about", SESSION_CHANNEL_DESCRIPTION],
              ],
            }),
          ]
        : [current],
  );
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    writer: {
      kinds: [9, 9007],
      sign: async (template) => signed(viewer, template),
      publish: async () => {},
    },
  });
  try {
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(owner.session.outbox?.supports(9000)).toBe(false);
    await expect(
      owner.session.workSessions.refreshMembership(id),
    ).resolves.toMatchObject({
      id,
      members: [viewer.pubkey],
    });
    expect(
      canAddMembers(owner.session, owner.session.channels.list().channels[0]),
    ).toBe(false);
    expect(
      query.mock.calls.some(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39002)),
      ),
    ).toBe(true);
  } finally {
    owner.dispose();
  }
});

it.each([false, true])(
  "retries the identical saved creation after it never reached the relay (channel kit: %s)",
  async (kit) => {
    const viewer = keypair(),
      relay = keypair();
    const id = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Release notes"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", "Updates for the team"],
        ["ttl", "604800"],
      ],
    });
    const sessionCreation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [
        ["h", "22222222-2222-4222-8222-222222222222"],
        ["name", "Work"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", SESSION_CHANNEL_DESCRIPTION],
      ],
    });
    let records: readonly OutgoingEvent[] = [
      { event: creation, signed: creation, delivery: "unknown", guarded: kit },
      {
        event: sessionCreation,
        signed: sessionCreation,
        delivery: "accepted",
      },
    ];
    const sign = vi.fn(async () => creation);
    let delivered = false;
    let dropping = true;
    const publish = vi.fn(async (_event: typeof creation) => {
      if (dropping) throw new Error("connection lost");
      delivered = true;
    });
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query: async () =>
          delivered
            ? [
                creation,
                roster(relay, id, [viewer.pubkey]),
                signed(relay, {
                  kind: 39000,
                  content: "",
                  tags: [["d", id], ["name", "Release notes"], ["private"]],
                }),
              ]
            : [],
        writer: { kinds: [9, 9000, 9007], sign, publish },
        ...(kit
          ? { channelKit: { decode: async () => [], prepare: async () => "" } }
          : {}),
      },
      {
        outboxStorage: {
          load: () => structuredClone(records),
          save: (next) => {
            records = structuredClone(next);
          },
        },
      },
    );
    try {
      await vi.waitFor(() =>
        expect(owner.session.channelCreation.snapshot()).toEqual({
          name: "Release notes",
          description: "Updates for the team",
          visibility: "private",
          ttlSeconds: 604800,
        }),
      );
      await expect(
        owner.session.channelCreation.create({
          name: "Different",
          visibility: "open",
        }),
      ).rejects.toThrow(/still awaiting confirmation/);
      await expect(
        owner.session.channelCreation.create({
          name: "Release notes",
          description: "Updates for the team",
          visibility: "private",
          ttlSeconds: 604800,
        }),
      ).rejects.toThrow(/connection lost/);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]?.[0]).toEqual(creation);
      expect(
        owner.session.outbox
          ?.snapshot()
          .filter((item) => item.event.id === creation.id),
      ).toHaveLength(1);
      dropping = false;
      await expect(
        owner.session.channelCreation.create({
          name: "Release notes",
          description: "Updates for the team",
          visibility: "private",
          ttlSeconds: 604800,
        }),
      ).resolves.toBe(id);
      expect(sign).not.toHaveBeenCalled();
      expect(publish.mock.calls.map(([event]) => event)).toEqual([
        creation,
        creation,
      ]);
      expect(owner.session.channelCreation.snapshot()).toBeUndefined();
    } finally {
      owner.dispose();
    }
  },
);

it.each([false, true])(
  "retains a seen channel creation while creator membership is unconfirmed (channel kit: %s)",
  async (kit) => {
    // Receipt inspection is advisory: a blocked storage getter must not turn
    // already-confirmed recovery back into a failed form after Outbox retirement.
    const receiptRead = vi.fn(() => {
      throw new Error("Storage blocked");
    });
    if (kit) vi.stubGlobal("localStorage", { getItem: receiptRead });
    const viewer = keypair(),
      relay = keypair();
    const id = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Release notes"],
        ["visibility", "open"],
        ["channel_type", "stream"],
      ],
    });
    let records: readonly OutgoingEvent[] = [
      { event: creation, signed: creation, delivery: "seen" },
    ];
    const sign = vi.fn(async () => creation);
    const publish = vi.fn(async () => {});
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: { kinds: [9, 9000, 9007], sign, publish },
        ...(kit
          ? { channelKit: { decode: async () => [], prepare: async () => "" } }
          : {}),
      },
      {
        outboxStorage: {
          load: () => structuredClone(records),
          save: (next) => {
            records = structuredClone(next);
          },
        },
      },
    );
    const input = { name: "Release notes", visibility: "open" as const };
    try {
      await vi.waitFor(() =>
        expect(owner.session.channelCreation.snapshot()).toEqual(input),
      );
      const creating = owner.session.channelCreation.create(input);
      await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
      const publicMetadata = signed(relay, {
        kind: 39000,
        content: JSON.stringify({ name: "Release notes" }),
        tags: [["d", id], ["name", "Release notes"], ["public"]],
      });
      wire.next().respond([publicMetadata]);
      await vi.waitFor(() =>
        expect(owner.session.channels.get?.(id)?.readOnly).toBe(true),
      );
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(owner.session.channelCreation.snapshot()).toEqual(input);
      expect(records).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ id: creation.id }),
          delivery: "seen",
        }),
      );

      owner.session.channels.refreshList?.();
      await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
      wire.next().respond([roster(relay, id, [viewer.pubkey]), publicMetadata]);
      await expect(creating).resolves.toBe(id);
      await vi.waitFor(() =>
        expect(records.some(({ event }) => event.id === creation.id)).toBe(
          false,
        ),
      );
      expect(owner.session.channelCreation.snapshot()).toBeUndefined();
      if (kit) {
        expect(receiptRead).toHaveBeenCalled();
        expect(owner.session.channelCreation.notices()[0]).toMatchObject({
          id,
        });
      }
    } finally {
      owner.dispose();
      if (kit) vi.unstubAllGlobals();
    }
  },
);

it("keeps a seen private creation through an access purge and reconnect", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const creation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Private notes"],
      ["visibility", "private"],
      ["channel_type", "stream"],
    ],
  });
  const sessionCreation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", "22222222-2222-4222-8222-222222222222"],
      ["name", "Old session"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", SESSION_CHANNEL_DESCRIPTION],
    ],
  });
  const input = { name: "Private notes", visibility: "private" as const };
  let records: readonly OutgoingEvent[] = [
    { event: creation, signed: creation, delivery: "seen" },
    { event: sessionCreation, signed: sessionCreation, delivery: "seen" },
  ];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const sign = vi.fn(async () => creation);
  const publish = vi.fn(async () => {});
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    { ...wire.transport, writer: { kinds: [9007], sign, publish } },
    { outboxStorage: storage },
  );
  try {
    await vi.waitFor(() =>
      expect(owner.session.channelCreation.snapshot()).toEqual(input),
    );
    owner.session.channels.ensureList();
    wire.next().respond([]); // Complete roster does not yet include the creator.
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(owner.session.channels.list().channels).toHaveLength(0);
    expect(owner.session.channelCreation.snapshot()).toEqual(input);
    await vi.waitFor(() =>
      expect(records).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ id: creation.id }),
          delivery: "seen",
        }),
      ]),
    );
  } finally {
    owner.dispose();
  }

  const restored = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      writer: { kinds: [9007], sign, publish },
    },
    { outboxStorage: storage },
  );
  try {
    await vi.waitFor(() =>
      expect(restored.session.channelCreation.snapshot()).toEqual(input),
    );
    const retry = restored.session.channelCreation.create(input);
    await flush();
    expect(sign).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    restored.dispose();
    await expect(retry).rejects.toThrow(/connection changed/);
  } finally {
    restored.dispose();
  }
});

it("retries a seen creation after a real roster read error", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const creation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
    ],
  });
  const input = { name: "Release notes", visibility: "open" as const };
  let records: readonly OutgoingEvent[] = [
    { event: creation, signed: creation, delivery: "seen" },
  ];
  const sign = vi.fn(async () => creation);
  const publish = vi.fn(async () => {});
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    { ...wire.transport, writer: { kinds: [9007], sign, publish } },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    await vi.waitFor(() =>
      expect(owner.session.channelCreation.snapshot()).toEqual(input),
    );
    owner.session.channels.ensureList();
    wire.next().fail(new Error("roster read failed"));
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("error"),
    );
    let settled = false;
    const retry = owner.session.channelCreation.create(input).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    expect(settled).toBe(false);
    const publicMetadata = signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "Release notes" }),
      tags: [["d", id], ["name", "Release notes"], ["public"]],
    });
    wire.next().respond([roster(relay, id, [viewer.pubkey]), publicMetadata]);
    await expect(retry).resolves.toBe(id);
    expect(records).toHaveLength(0);
    expect(owner.session.channelCreation.snapshot()).toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it("removes a successfully refreshed channel creation from durable recovery", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let records: readonly OutgoingEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    const creating = owner.session.channelCreation.create({
      name: "Release notes",
      visibility: "open",
    });
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
    );
    const id = records
      .find(({ event }) => event.kind === 9007)
      ?.event.tags.find(([name]) => name === "h")?.[1];
    expect(id).toBeTypeOf("string");
    const publicMetadata = signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "Release notes" }),
      tags: [["d", id ?? ""], ["name", "Release notes"], ["public"]],
    });
    await vi.waitFor(() => expect(wire.pending).toHaveLength(2));
    for (const request of [wire.next(), wire.next()])
      request.respond([publicMetadata]);
    await vi.waitFor(() =>
      expect(owner.session.channels.get?.(id ?? "")?.readOnly).toBe(true),
    );
    let resolved = false;
    void creating.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    expect(records.some(({ event }) => event.kind === 9007)).toBe(true);

    owner.session.channels.refreshList?.();
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    wire
      .next()
      .respond([roster(relay, id ?? "", [viewer.pubkey]), publicMetadata]);
    await expect(creating).resolves.toBe(id);
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(false),
    );
    expect(owner.session.channelCreation.snapshot()).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it.each<["open" | "private", string[][]]>([
  ["open", [["public"]]],
  ["private", [["private"]]],
])(
  "admits a created %s channel through the store's exact read without rediscovering the roster",
  async (visibility, tags) => {
    const viewer = keypair(),
      relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let records: readonly OutgoingEvent[] = [];
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish: async () => {},
        },
      },
      {
        outboxStorage: {
          load: () => structuredClone(records),
          save: (next) => {
            records = structuredClone(next);
          },
        },
      },
    );
    try {
      // A loaded sidebar whose complete viewer roster is still empty.
      owner.session.channels.ensureList();
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      wire.next().respond([]);
      await vi.waitFor(() =>
        expect(owner.session.channels.list()).toMatchObject({
          status: "ready",
          channels: [],
        }),
      );
      const notified = vi.fn();
      const unsubscribe = owner.session.channels.subscribeList(notified);
      const creating = owner.session.channelCreation.create({
        name: "Release notes",
        visibility,
      });
      await vi.waitFor(() =>
        expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
      );
      const id =
        records
          .find(({ event }) => event.kind === 9007)
          ?.event.tags.find(([name]) => name === "h")?.[1] ?? "";
      // After publish: the outbox's receipt readback and the one exact lookup.
      await vi.waitFor(() => expect(wire.pending).toHaveLength(2));
      const exact = wire.pending.find((request) =>
        request.filters.some((filter) => filter["#d"]),
      );
      expect(exact?.filters).toEqual([
        { kinds: [39000], authors: [relay.pubkey], "#d": [id], limit: 2 },
        {
          kinds: [39002],
          authors: [relay.pubkey],
          "#d": [id],
          "#p": [viewer.pubkey],
          limit: 2,
        },
      ]);
      for (const request of wire.pending.splice(0))
        request.respond(
          request === exact
            ? [
                metadata(relay, id, "Release notes", undefined, tags),
                roster(relay, id, [viewer.pubkey]),
              ]
            : [],
        );
      await expect(creating).resolves.toBe(id);
      expect(owner.session.channels.list()).toMatchObject({
        status: "ready",
        channels: [{ id, name: "Release notes", members: [viewer.pubkey] }],
      });
      expect(notified).toHaveBeenCalledOnce();
      await flush();
      // No viewer-wide roster page followed the exact read.
      expect(wire.pending).toHaveLength(0);
      unsubscribe();
    } finally {
      owner.dispose();
    }
  },
);

it("creates a channel during initial discovery without committing a list of only that channel", async () => {
  const viewer = keypair(),
    relay = keypair();
  const other = "22222222-2222-4222-8222-222222222222";
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let records: readonly OutgoingEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    owner.session.channels.ensureList();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    expect(owner.session.channels.list().status).toBe("loading");
    const snapshots: ReturnType<ChannelQueries["list"]>[] = [];
    const unsubscribe = owner.session.channels.subscribeList(() =>
      snapshots.push(owner.session.channels.list()),
    );
    const creating = owner.session.channelCreation.create({
      name: "Release notes",
      visibility: "open",
    });
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
    );
    const id =
      records
        .find(({ event }) => event.kind === 9007)
        ?.event.tags.find(([name]) => name === "h")?.[1] ?? "";
    // Serve every pending read: the viewer roster page lists `joined`, and
    // metadata answers whatever ids discovery asks for.
    const serve = (joined: readonly string[]) => {
      for (const request of wire.pending.splice(0)) {
        const [filter] = request.filters;
        request.respond(
          filter?.kinds?.includes(39002) && filter["#p"]
            ? joined.map((channel) => roster(relay, channel, [viewer.pubkey]))
            : filter?.kinds?.includes(39000)
              ? (filter["#d"] ?? []).map((channel) =>
                  metadata(
                    relay,
                    channel,
                    channel === id ? "Release notes" : "Existing",
                    undefined,
                    [["public"]],
                  ),
                )
              : [],
        );
      }
    };
    await flush();
    // Only the in-flight discovery page and the outbox receipt readback; the
    // exact read would commit a ready list holding just the new channel.
    expect(wire.pending).toHaveLength(2);
    expect(
      wire.pending.some((request) =>
        request.filters.some((filter) => filter["#d"]),
      ),
    ).toBe(false);
    // The in-flight page was served before the relay accepted the create.
    serve([other]);
    await vi.waitFor(() =>
      expect(
        snapshots.find((snapshot) => snapshot.status === "ready")?.channels,
      ).toEqual([expect.objectContaining({ id: other })]),
    );
    // The first pass finishes with its metadata read before the forced second
    // pass starts; that pass carries the new channel's roster.
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    serve([other]);
    await vi.waitFor(() =>
      expect(
        wire.pending.some((request) =>
          request.filters.some((filter) => filter["#p"]),
        ),
      ).toBe(true),
    );
    serve([other, id]);
    await expect(creating).resolves.toBe(id);
    expect(owner.session.channels.list()).toMatchObject({
      status: "ready",
      channels: expect.arrayContaining([
        expect.objectContaining({ id: other }),
        expect.objectContaining({ id, members: [viewer.pubkey] }),
      ]),
    });
    // Canonical check, cited from the store's `resolve` docstring: no ready
    // snapshot ever held only the new channel.
    expect(
      snapshots
        .filter((snapshot) => snapshot.status === "ready")
        .every((snapshot) =>
          snapshot.channels.some((channel) => channel.id === other),
        ),
    ).toBe(true);
    unsubscribe();
  } finally {
    owner.dispose();
  }
});

it.each([true, false])(
  "confirms an exact own creation without admitting a channel missing its roster (receipt: %s)",
  async (found) => {
    const viewer = keypair(),
      relay = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [["h", channelId]],
    });
    const publish = vi.fn(async () => {
      throw new PublishRejected("duplicate: channel already exists");
    });
    const query = vi.fn(async (filters: Parameters<RelaySessionRead>[0]) =>
      found && filters.some((filter) => filter.ids?.includes(creation.id))
        ? [creation]
        : [],
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish,
        },
      },
      {
        outboxStorage: {
          load: () => [
            { event: creation, signed: creation, delivery: "unknown" },
          ],
          save: () => {},
        },
      },
    );
    try {
      owner.session.channels.ensureList?.();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      if (found) {
        await owner.session.workSessions.delivered(creation.id);
        expect(publish).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledWith(
          [
            {
              kinds: [9007],
              ids: [creation.id],
              authors: [viewer.pubkey],
              limit: 1,
            },
          ],
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );
      } else {
        await expect(
          owner.session.workSessions.delivered(creation.id),
        ).rejects.toThrow(/duplicate/);
      }
      expect(owner.session.channels.list().channels).toHaveLength(0);
      expect(() =>
        owner.session.messages.send(channelId, "Work", [viewer.pubkey]),
      ).toThrow();
    } finally {
      owner.dispose();
    }
  },
);
type RelaySessionRead = ReturnType<
  typeof createRelaySession
>["session"]["read"];
function setup(
  channelCreation = true,
  initialList: ReturnType<ChannelQueries["list"]> = {
    status: "ready",
    channels: [],
  },
) {
  let items: readonly OutgoingEvent[] = [{ event, delivery: "accepted" }];
  let channelList = initialList;
  const listeners = new Set<() => void>();
  const listListeners = new Set<() => void>();
  const receipts = {
    snapshot: () => items,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const outbox: Outbox = {
    observeSend: () => () => {},
    ready: async () => {},
    recover: async () => {},
    acknowledge: async () => {},
    snapshot: () => [],
    subscribe: receipts.subscribe,
    supports: (kind) => channelCreation && [9, 9000, 9007].includes(kind),
    send: vi.fn(() => event.id),
    retry: vi.fn(() => {
      items = [{ event, delivery: "accepted" }];
      for (const fn of listeners) fn();
    }),
    dismiss: vi.fn(async () => {}),
  };
  // The store's exact lookup applies through discovery and notifies the list;
  // tests script that by changing the list from inside `resolve`. The real
  // store path is exercised by "admits a created ... through the store's exact
  // read without rediscovering the roster".
  const resolve = vi.fn<NonNullable<ChannelQueries["resolve"]>>(async () => {});
  const refreshList = vi.fn();
  const channels = {
    list: () => channelList,
    subscribeList: (fn: () => void) => {
      listListeners.add(fn);
      return () => {
        listListeners.delete(fn);
      };
    },
    resolve,
    refreshList,
  } as unknown as ChannelQueries;
  const reader = { read: vi.fn(async () => [event]) };
  const controller = new AbortController();
  return {
    service: createWorkSessions(
      outbox,
      channels,
      reader,
      controller.signal,
      receipts,
    ),
    outbox,
    channels,
    resolve,
    refreshList,
    reader,
    listeners,
    listListeners,
    controller,
    setItems: (next: readonly OutgoingEvent[]) => {
      items = next;
    },
    setList: (next: ReturnType<ChannelQueries["list"]>) => {
      channelList = next;
      for (const fn of listListeners) fn();
    },
  };
}
/** The signal `refresh` handed its exact lookup, released once the gate decides. */
function lookupSignal(test: ReturnType<typeof setup>) {
  const signal = test.resolve.mock.lastCall?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  return signal as AbortSignal;
}
it("confirms completed journal receipts after they leave the pending outbox", async () => {
  const test = setup();
  await test.service.delivered(event.id);
  expect(test.reader.read).not.toHaveBeenCalled();
  expect(test.listeners.size).toBe(0);
});
it("accepts already-applied creator membership without a refresh notification", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup(true, {
    status: "ready",
    channels: [{ id, name: "Release notes", members: [member] }],
  });
  await expect(
    test.service.refresh(id, { member }, false),
  ).resolves.toBeUndefined();
  // A list that already carries the signed membership needs no further read.
  expect(test.resolve).not.toHaveBeenCalled();
  expect(test.refreshList).not.toHaveBeenCalled();
  expect(test.listListeners.size).toBe(0);
});
it("admits a new channel from its exact lookup without a full discovery", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup();
  test.resolve.mockImplementation(async (ids) => {
    expect(ids).toEqual([id]);
    test.setList({
      status: "ready",
      channels: [{ id, name: "Release notes", members: [member] }],
    });
  });
  await expect(
    test.service.refresh(id, { member }, false),
  ).resolves.toBeUndefined();
  expect(test.resolve).toHaveBeenCalledExactlyOnceWith([id], {
    signal: expect.any(AbortSignal),
  });
  expect(lookupSignal(test).aborted).toBe(true);
  expect(test.refreshList).not.toHaveBeenCalled();
  expect(test.listListeners.size).toBe(0);
});
it("admits a channel the live roster lists while its exact lookup is still in flight", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup();
  test.resolve.mockImplementation(() => new Promise<void>(() => {}));
  const refreshing = test.service.refresh(id, { member }, false);
  await vi.waitFor(() => expect(test.resolve).toHaveBeenCalledOnce());
  const lookup = lookupSignal(test);
  expect(lookup.aborted).toBe(false);
  test.setList({
    status: "ready",
    channels: [{ id, name: "Release notes", members: [member] }],
  });
  await expect(refreshing).resolves.toBeUndefined();
  // The live roster decided, so the in-flight exact read is released rather
  // than left holding a reader slot until the connection closes.
  expect(lookup.aborted).toBe(true);
  expect(test.controller.signal.aborted).toBe(false);
  expect(test.refreshList).not.toHaveBeenCalled();
});
it.each(["idle", "loading", "error"] as const)(
  "waits for the full discovery instead of an exact lookup while the list is %s",
  async (status) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const member = "a".repeat(64);
    const test = setup(true, {
      status,
      channels: [],
      ...(status === "error" ? { error: "offline" } : {}),
    });
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(test.refreshList).toHaveBeenCalledOnce());
    expect(test.resolve).not.toHaveBeenCalled();
    await flush();
    expect(settled).toBe(false);
    test.setList({
      status: "ready",
      channels: [{ id, name: "Release notes", members: [member] }],
    });
    await expect(refreshing).resolves.toBeUndefined();
    expect(test.resolve).not.toHaveBeenCalled();
    expect(test.listListeners.size).toBe(0);
  },
);
it.each([
  ["without the viewer", async () => {}],
  [
    "as stale",
    async () => {
      throw new DOMException("Stale channel resolution", "AbortError");
    },
  ],
])(
  "falls back to the full discovery when the exact lookup returns %s",
  async (_outcome, lookup) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const member = "a".repeat(64);
    const test = setup();
    test.resolve.mockImplementation(lookup);
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(test.refreshList).toHaveBeenCalledOnce());
    expect(test.resolve).toHaveBeenCalledExactlyOnceWith([id], {
      signal: expect.any(AbortSignal),
    });
    expect(test.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      test.refreshList.mock.invocationCallOrder[0] ?? 0,
    );
    await flush();
    expect(settled).toBe(false);
    test.setList({
      status: "ready",
      channels: [{ id, name: "Release notes", members: [member] }],
    });
    await expect(refreshing).resolves.toBeUndefined();
    expect(test.refreshList).toHaveBeenCalledOnce();
    expect(test.listListeners.size).toBe(0);
  },
);
it.each([true, false])(
  "gives up 15 seconds after refresh starts when the exact lookup never answers (session: %s)",
  async (sessionOnly) => {
    vi.useFakeTimers();
    try {
      const id = "11111111-1111-4111-8111-111111111111";
      const member = "a".repeat(64);
      const test = setup();
      test.resolve.mockImplementation(() => new Promise<void>(() => {}));
      let settled = false;
      const refreshing = test.service
        .refresh(id, { member }, sessionOnly)
        .finally(() => {
          settled = true;
        });
      const failure = expect(refreshing).rejects.toThrow(
        sessionOnly
          ? /membership is still loading/
          : /Agent addition is unconfirmed/,
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      // The deadline decided; a hung exact read must not start discovery late,
      // and its reader slot is released without waiting for the connection.
      expect(test.refreshList).not.toHaveBeenCalled();
      expect(lookupSignal(test).aborted).toBe(true);
      expect(test.controller.signal.aborted).toBe(false);
      expect(test.listListeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("counts the fallback discovery against the same 15 second deadline", async () => {
  vi.useFakeTimers();
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const member = "a".repeat(64);
    const test = setup();
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    const failure = expect(refreshing).rejects.toThrow(
      /Agent addition is unconfirmed/,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.refreshList).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(test.listListeners.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("retries the same unknown event and confirms restored receipts through verified reads", async () => {
  const test = setup();
  test.setItems([{ event, delivery: "unknown" }]);
  await test.service.delivered(event.id);
  expect(test.outbox.retry).toHaveBeenCalledWith(event.id);
  test.setItems([]);
  await test.service.delivered(event.id);
  expect(test.reader.read).toHaveBeenCalled();
});
it("fails closed when capability is absent or connection ends", async () => {
  const unsupported = setup(false);
  expect(unsupported.service.available).toBe(false);
  expect(() =>
    unsupported.service.create("11111111-1111-4111-8111-111111111111", "Work"),
  ).toThrow(/does not support/);
  const test = setup();
  test.setItems([{ event, delivery: "sending" }]);
  const pending = test.service.delivered(event.id);
  test.controller.abort();
  await expect(pending).rejects.toThrow(/connection changed/);
  expect(test.listeners.size).toBe(0);
});

it("permits editing only after a definitive rejection, never an uncertain send", async () => {
  const test = setup();
  test.setItems([{ event, delivery: "unknown" }]);
  expect(test.service.failed(event.id)).toBe(false);
  await expect(test.service.discardFailed(event.id)).rejects.toThrow(
    /unconfirmed/,
  );
  expect(test.outbox.dismiss).not.toHaveBeenCalled();
  test.setItems([{ event, delivery: "failed" }]);
  expect(test.service.failed(event.id)).toBe(true);
  await test.service.discardFailed(event.id);
  expect(test.outbox.dismiss).toHaveBeenCalledWith(event.id);
});

it("starts a standalone session using existing private-channel creation without the Sessions extension", () => {
  const test = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  expect(test.service.available).toBe(true);
  test.service.create(id, "Work");
  expect(test.outbox.send).toHaveBeenCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  });
  const parent = "22222222-2222-4222-8222-222222222222";
  test.service.create(id, "Child", parent);
  expect(test.outbox.send).toHaveBeenLastCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Child"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", `${SESSION_CHANNEL_DESCRIPTION}\nparent:${parent}`],
    ],
  });
  expect(() => test.service.create(id, "Child", id)).toThrow(/own parent/);
  expect(test.outbox.send).toHaveBeenCalledTimes(2);
});

it("creates an ordinary stream with explicit visibility and optional description", () => {
  const test = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  test.service.createChannel(id, "  Release notes  ", "open", "  Updates  ");
  expect(test.outbox.send).toHaveBeenCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Release notes"],
        ["visibility", "open"],
        ["channel_type", "stream"],
        ["about", "Updates"],
      ],
    },
    undefined,
    undefined,
  );
  test.service.createChannel(id, "Private", "private");
  expect(test.outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Private"],
        ["visibility", "private"],
        ["channel_type", "stream"],
      ],
    },
    undefined,
    undefined,
  );
  test.service.createChannel(id, "Standup", "open", undefined, 604800);
  expect(test.outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Standup"],
        ["visibility", "open"],
        ["channel_type", "stream"],
        ["ttl", "604800"],
      ],
    },
    undefined,
    undefined,
  );
  for (const description of [
    SESSION_CHANNEL_DESCRIPTION,
    "Buzz session (notes)",
  ]) {
    expect(() =>
      test.service.createChannel(id, "Not a session", "private", description),
    ).toThrow(/different channel description/);
  }
  expect(test.outbox.send).toHaveBeenCalledTimes(3);
  expect(() => test.service.createChannel(id, " ", "open")).toThrow(/name/);
  expect(() =>
    test.service.createChannel(id, "Work", "open", "x".repeat(1001)),
  ).toThrow(/description/);
  expect(() =>
    test.service.createChannel(id, "Work", "open", undefined, 0),
  ).toThrow(/duration/);
});

it("recovers a lost normal-channel creation acknowledgment only with its exact verified event", async () => {
  const test = setup();
  const creation = signed(keypair(), {
    kind: 9007,
    content: "",
    tags: [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", SESSION_CHANNEL_DESCRIPTION],
    ],
  });
  test.setItems([{ event: creation, delivery: "unknown" }]);
  test.reader.read.mockResolvedValueOnce([creation]);
  await test.service.delivered(creation.id);
  expect(test.outbox.retry).not.toHaveBeenCalled();
  expect(test.reader.read).toHaveBeenCalledWith(
    [
      {
        kinds: [39000, 39002],
        "#d": ["11111111-1111-4111-8111-111111111111"],
        limit: 2,
      },
      { ids: [creation.id], limit: 1 },
    ],
    expect.anything(),
  );
});

it.each([true, false])(
  "checks fresh roster access before recovering creation (member: %s)",
  async (member) => {
    const viewer = keypair(),
      relay = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [["h", channelId]],
    });
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        filters.some((filter) => filter.ids)
          ? [creation, roster(relay, channelId, member ? [viewer.pubkey] : [])]
          : [],
    });
    try {
      owner.session.channels.ensureList?.();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      let items: readonly OutgoingEvent[] = [
        { event: creation, delivery: "unknown" },
      ];
      const outbox: Outbox = {
        observeSend: () => () => {},
        ready: async () => {},
        recover: async () => {},
        acknowledge: async () => {},
        supports: () => true,
        send: vi.fn(),
        snapshot: () => items,
        subscribe: () => () => {},
        retry: vi.fn(() => {
          items = [{ event: creation, delivery: "failed" }];
        }),
        dismiss: async () => {},
      };
      const service = createWorkSessions(
        outbox,
        owner.session.channels,
        {
          read: async (filters, options) => {
            const visible = await owner.session.read(filters, options);
            return visible.some((event) => event.id === creation.id)
              ? [creation]
              : [];
          },
        },
        new AbortController().signal,
      );
      if (member) {
        await service.delivered(creation.id);
        expect(outbox.retry).not.toHaveBeenCalled();
      } else {
        await expect(service.delivered(creation.id)).rejects.toThrow(
          /could not be confirmed/,
        );
        expect(outbox.retry).toHaveBeenCalledWith(creation.id);
      }
    } finally {
      owner.dispose();
    }
  },
);

it("confirms shared delivery without channel-creation authority while additions remain gated", async () => {
  const test = setup(false);
  await expect(test.service.delivered(event.id)).resolves.toBeUndefined();
  await expect(
    test.service.delivered(event.id, () => true, true),
  ).rejects.toThrow(/cannot add agents/);
  test.controller.abort();
  await expect(test.service.delivered(event.id)).rejects.toThrow(
    /cannot confirm/,
  );
});

it("rejects an addition cancelled during delivery readback", async () => {
  const test = setup();
  test.setItems([]);
  let active = true;
  test.reader.read.mockImplementationOnce(async () => {
    active = false;
    return [event];
  });
  await expect(
    test.service.delivered(event.id, () => active, true),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(test.outbox.retry).not.toHaveBeenCalled();
});
