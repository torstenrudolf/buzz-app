import { afterEach, assert, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "./channel-details";
import {
  channelVisibility,
  canonicalDetailsName,
  detailsSettings,
  detailsTemplate,
  validateDetailsTemplate,
} from "./channel-details-protocol";
import { PublishRejected } from "./outbox";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { sessionDescription } from "../sessions/metadata";
import type { ReadFilter } from "./events";

const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const id = "11111111-1111-4111-8111-111111111111";
const draft = {
  name: "renamed",
  description: "New description",
  visibility: "private" as const,
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(role = "owner") {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], created_at: clock++, content: "" },
      relayKey,
    );
  const metadata = (
    name = "original",
    description = "Old description",
    visibility = "public",
    type = "stream",
  ) =>
    record(39000, [
      ["name", name],
      ["about", description],
      [visibility],
      ["t", type],
    ]);
  let events = [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ];
  const read = vi.fn(async () => events);
  const sign = vi.fn(async (event: EventTemplate) =>
    finalizeEvent(structuredClone(event), key),
  );
  const publish = vi.fn(async () => {
    events = [
      metadata(draft.name, draft.description, draft.visibility),
      ...events.slice(1),
    ];
  });
  const acceptDiscovery = vi.fn();
  let active = true;
  const owner = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    canAccess: () => active,
    acceptDiscovery,
  });
  cleanup.push(owner.dispose);
  const entry = (index: number) => {
    const value = events[index];
    assert(value);
    return value;
  };
  return {
    entry,
    owner,
    read,
    sign,
    publish,
    acceptDiscovery,
    metadata,
    record,
    events: () => events,
    set: (next: RelayEvent[]) => {
      events = next;
    },
    revoke: () => {
      active = false;
    },
  };
}
it("saves only after two fresh authority checks and projects confirmed readback", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.acceptDiscovery.mockClear();
  h.read.mockClear();
  await h.owner.capability.save(base, draft);
  expect(h.read).toHaveBeenCalledTimes(3);
  for (const call of h.read.mock.calls as unknown as [unknown, unknown][]) {
    expect(call).toEqual([
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      expect.objectContaining({ fresh: true, priority: "foreground" }),
    ]);
  }
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.acceptDiscovery).toHaveBeenCalledWith([h.events()[0]]);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it.each(["owner", "admin", "member"])(
  "derives current direct %s authority",
  async (role) => {
    const h = harness(role);
    const base = await h.owner.capability.load(id);
    expect(base.canEdit).toBe(role !== "member");
    if (role === "member") {
      await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
        "permission",
      );
      expect(h.sign).not.toHaveBeenCalled();
    }
  },
);
it("revoked authority while signing prevents publication", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    h.set([h.entry(0), h.record(39001, []), h.entry(2)]);
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "permission",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("stale edit base and private-to-public requests fail before signing", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.set([h.metadata("changed"), ...h.events().slice(1)]);
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow("changed");
  h.set([h.metadata("changed", "", "private"), ...h.events().slice(1)]);
  const privateBase = await h.owner.capability.load(id);
  await expect(
    h.owner.capability.save(privateBase, { ...draft, visibility: "public" }),
  ).rejects.toThrow("cannot be made public");
  expect(h.sign).not.toHaveBeenCalled();
});
it("saves retained edits after reloading a channel made private by another editor", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.set([
    h.metadata("other edit", "Other description", "private"),
    ...h.events().slice(1),
  ]);
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("Reload details");
  expect(h.sign).not.toHaveBeenCalled();
  const reloaded = await h.owner.capability.load(id);
  await h.owner.capability.save(reloaded, {
    ...draft,
    visibility: reloaded.visibility,
  });
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it.each(["dm", "session", "archived"])("does not edit %s", async (type) => {
  const h = harness();
  const tags = [
    ["name", "name"],
    ["about", type === "session" ? sessionDescription(id) : ""],
    ["private"],
    ["t", type === "dm" ? "dm" : "stream"],
    ...(type === "archived" ? [["archived", "true"]] : []),
  ];
  h.set([h.record(39000, tags), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  expect(base.canEdit).toBe(false);
});
it("rejects unknown visibility, foreign coordinates and malformed admin state", async () => {
  const h = harness();
  for (const metadata of [
    h.record(39000, [
      ["name", "name"],
      ["t", "stream"],
    ]),
    h.record(39000, [
      ["name", "name"],
      ["t", "stream"],
      ["public"],
      ["private"],
    ]),
    h.record(39000, [
      ["d", "other"],
      ["name", "name"],
      ["t", "stream"],
      ["public"],
    ]),
  ]) {
    expect(() =>
      detailsSettings(
        [metadata, ...h.events().slice(1)],
        id,
        viewer,
        relayAuthor,
      ),
    ).toThrow();
  }
  expect(() => detailsSettings(h.events(), id, viewer, viewer)).toThrow();
  expect(() =>
    detailsSettings(
      [
        h.entry(0),
        h.record(39001, [
          ["p", viewer, "owner"],
          ["p", viewer, "admin"],
        ]),
        h.entry(2),
      ],
      id,
      viewer,
      relayAuthor,
    ),
  ).toThrow();
});
it("rejects an in-place mutated signer response", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    event.tags[1] = ["name", "surprise"];
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "Signer changed",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("retains edits on rejection but locks unknown outcomes until read-only confirmation", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.publish.mockRejectedValueOnce(new PublishRejected("Not permitted"));
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "Not permitted",
  );
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  h.publish.mockRejectedValueOnce(new Error("lost response"));
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft,
    status: "unconfirmed",
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "previous change",
  );
  await expect(h.owner.capability.check(id)).rejects.toThrow(
    "may have been saved",
  );
  h.set([
    h.metadata(draft.name, draft.description, draft.visibility),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it("receipt alone is not success and repeated Save cannot publish twice", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  const gate = deferred<void>(),
    started = deferred<void>();
  h.publish.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
  });
  const result = expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "may have been saved",
  );
  await started.promise;
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "previous change",
  );
  gate.resolve();
  await result;
  expect(h.owner.capability.snapshot(id)?.status).toBe("unconfirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each(["cancel", "clear", "dispose"] as const)(
  "%s fences late publication/readback",
  async (action) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    h.acceptDiscovery.mockClear();
    const gate = deferred<void>(),
      started = deferred<void>();
    h.publish.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      h.set([
        h.metadata(draft.name, draft.description, draft.visibility),
        ...h.events().slice(1),
      ]);
    });
    const result = expect(
      h.owner.capability.save(base, draft),
    ).rejects.toThrow();
    await started.promise;
    h.owner[action]();
    gate.resolve();
    await result;
    expect(h.acceptDiscovery).not.toHaveBeenCalled();
    expect(h.owner.capability.snapshot(id)?.status).toBe(
      action === "dispose" ? undefined : "unconfirmed",
    );
  },
);
it("access loss and an aborted late load cannot update discovery", async () => {
  const h = harness();
  const gate = deferred<RelayEvent[]>();
  h.read.mockImplementationOnce(() => gate.promise);
  const result = expect(h.owner.capability.load(id)).rejects.toThrow();
  h.revoke();
  h.owner.cancel();
  gate.resolve(h.events());
  await result;
  expect(h.acceptDiscovery).not.toHaveBeenCalled();
});
it("admits only bounded name/about/private metadata and preserves explicit description clearing", () => {
  const template = detailsTemplate(id, { ...draft, description: "" });
  expect(template.tags).toContainEqual(["about", ""]);
  expect(() => validateDetailsTemplate(template)).not.toThrow();
  const invalid = [
    { ...template, kind: 9000 },
    { ...template, content: "extra" },
    { ...template, tags: [...template.tags, ["ttl", "10"]] },
    ...["open", "public", ""].map((value) => ({
      ...template,
      tags: [...template.tags.slice(0, 3), ["visibility", value]],
    })),
    {
      ...template,
      tags: [
        ["h", id],
        ["name", " "],
        ["about", ""],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "x".repeat(121)],
        ["about", ""],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "name"],
        ["about", "x".repeat(1001)],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "name"],
        ["about", "Buzz session (fake)"],
      ],
    },
  ];
  for (const event of invalid)
    expect(() => validateDetailsTemplate(event)).toThrow();
  const h = harness();
  expect(channelVisibility(h.record(39000, []))).toBeUndefined();
});

it("production session wiring updates shared discovery and cancels a retiring owner's read", async () => {
  const h = harness();
  const owner = createRelaySession({
    viewer,
    relayAuthor,
    query: async (filters: readonly ReadFilter[]) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
    channelDetails: { sign: h.sign, publish: h.publish },
    media: (url) => url,
  });
  cleanup.push(owner.dispose);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const base = await owner.session.channelDetails.load(id);
  await owner.session.channelDetails.save(base, draft);
  expect(owner.session.channels.list().channels[0]).toMatchObject({
    name: draft.name,
    description: draft.description,
    visibility: "private",
  });
  owner.dispose();
  await expect(owner.session.channelDetails.load(id)).rejects.toThrow();
});

it.each([
  ["\u0085# \u0085#renamed\u0085", "renamed"],
  ["\t # # renamed\u00a0", "renamed"],
  ["\u2000#renamed\u3000", "renamed"],
  ["\ufeffrenamed\ufeff", "\ufeffrenamed\ufeff"],
  ["re\u0085named#", "re\u0085named#"],
])(
  "uses relay canonicalization for %j before signing and confirming",
  async (input, expected) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    const name = canonicalDetailsName(input);
    expect(name).toBe(expected);
    if (input !== expected) {
      await expect(
        h.owner.capability.save(base, { ...draft, name: input }),
      ).rejects.toThrow("Enter a channel name");
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.owner.capability.snapshot(id)).toBeUndefined();
      const command = detailsTemplate(id, draft);
      command.tags[1] = ["name", input];
      expect(() => validateDetailsTemplate(command)).toThrow(
        "Enter a channel name",
      );
    }
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.metadata(expected, draft.description, draft.visibility),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, { ...draft, name });
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual(["name", expected]);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
