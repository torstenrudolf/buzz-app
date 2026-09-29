// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { LiveCallbacks } from "../../features/relay/live";
import { keypair, profile, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import { profileTarget } from "../../features/profiles/target";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ProfilePanel } from "./ProfilePanel";

const person = keypair(),
  human = keypair();
const metadata = (body: unknown, time = 2) =>
  signed(person, {
    kind: 10100,
    content: JSON.stringify(body),
    tags: [],
    created_at: time,
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup(
  initial = [
    metadata({ agent_type: "goose", capabilities: ["code", "search"] }),
  ],
  wrap: (session: RelaySession) => RelaySession = (session) => session,
) {
  let events = [
    profile(
      person,
      { name: "Agent", is_agent: true, nip05: "agent@example.test" },
      1,
    ),
    profile(human, { name: "Human", nip05: "human@example.test" }, 1),
    ...initial,
  ];
  let live!: LiveCallbacks;
  let fail: boolean | "all" = false;
  const query = vi.fn(async (filters) => {
    if (
      fail === "all" ||
      (fail &&
        filters.some((f: { kinds?: number[] }) => f.kinds?.includes(10100)))
    )
      throw new Error("unavailable");
    return events.filter((event) =>
      filters.some((filter: Parameters<typeof matchesEvent>[1]) =>
        matchesEvent(event, filter),
      ),
    );
  });
  const owner = createRelaySession({
    viewer: human.pubkey,
    relayAuthor: keypair().pubkey,
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: wrap(owner.session),
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const tree = (key: string) => (
    <StrictMode>
      <ToastProvider>
        <ProfilePanel
          relay={relay}
          target={profileTarget(key) ?? ""}
          close={() => {}}
        />
      </ToastProvider>
    </StrictMode>
  );
  return {
    owner,
    query,
    tree,
    fail: (value: boolean | "all") => {
      fail = value;
    },
    emit: async (event: (typeof events)[number]) => {
      events = [...events, event];
      await act(async () => {
        live.receive([event]);
      });
    },
  };
}

it("renders base labels/order, copies raw type/capabilities/NIP-05 and preserves npub behavior", async () => {
  const h = setup();
  const user = userEvent.setup();
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  try {
    render(h.tree(person.pubkey));
    const type = await screen.findByRole("button", {
      name: /^Copy Agent type:/,
    });
    expect(type).toHaveTextContent("Goose");
    expect(screen.queryByText("NIP-05 (unverified)")).not.toBeInTheDocument();
    const nip = screen.getByRole("button", { name: /^Copy NIP-05:/ });
    const cap = screen.getByRole("button", { name: /^Copy Capabilities:/ });
    expect(nip).toHaveAccessibleName("Copy NIP-05: agent@example.test");
    expect(type).toHaveAccessibleName("Copy Agent type: Goose");
    expect(cap).toHaveAccessibleName("Copy Capabilities: code, search");
    expect(
      screen
        .getByRole("button", { name: "Copy npub" })
        .compareDocumentPosition(nip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      nip.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      type.compareDocumentPosition(cap) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const [button, value, feedback] of [
      [type, "goose", "Copied agent type"],
      [cap, "code, search", "Copied capabilities"],
      [nip, "agent@example.test", "Copied nip-05"],
    ] as const) {
      await user.click(button);
      expect(clipboard).toHaveBeenLastCalledWith(value);
      await screen.findByText(feedback);
      expect(button.querySelector("[data-copied]")).toHaveAttribute(
        "data-copied",
        "true",
      );
    }
    await user.click(screen.getByRole("button", { name: "Copy npub" }));
    expect(clipboard).toHaveBeenLastCalledWith(
      profileTarget(person.pubkey)?.slice(6),
    );
    expect(await screen.findByText("Public key copied.")).toBeInTheDocument();
    clipboard.mockRejectedValueOnce(new Error("denied"));
    await user.click(nip);
    await screen.findByText("Couldn't copy nip-05.");
    expect(nip.querySelector("[data-copied]")).toHaveAttribute(
      "data-copied",
      "false",
    );
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

it("updates and clears live metadata, ignores older results and isolates human navigation", async () => {
  const h = setup();
  try {
    const mounted = render(h.tree(person.pubkey));
    await screen.findByRole("button", { name: /^Copy Agent type:/ });
    await h.emit(
      metadata({ agent_type: "codex-acp", capabilities: ["review"] }, 3),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Copy Agent type:/ }),
      ).toHaveTextContent("Codex"),
    );
    await h.emit(metadata({ agent_type: "aider", capabilities: ["old"] }, 2));
    expect(
      screen.getByRole("button", { name: /^Copy Agent type:/ }),
    ).toHaveTextContent("Codex");
    await h.emit(metadata({ agent_type: "", capabilities: [] }, 4));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Copy Agent type:/ }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /^Copy Capabilities:/ }),
    ).not.toBeInTheDocument();
    await h.emit(
      profile(
        person,
        { name: "Agent", is_agent: true, nip05: { malformed: true } },
        5,
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Copy NIP-05:/ }),
      ).not.toBeInTheDocument(),
    );
    mounted.rerender(h.tree(human.pubkey));
    await screen.findByRole("heading", { name: "Human" });
    expect(
      screen.getByRole("button", { name: /^Copy NIP-05:/ }),
    ).toHaveTextContent("human@example.test");
    expect(
      screen.queryByRole("button", { name: /^Copy Agent type:/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Copy Capabilities:/ }),
    ).not.toBeInTheDocument();
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

it("exposes read recovery without treating failure as absent metadata", async () => {
  const h = setup();
  h.fail(true);
  try {
    render(h.tree(person.pubkey));
    await screen.findByRole("button", { name: "Retry profile" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Copy Agent type:/ }),
    ).not.toBeInTheDocument();
    h.fail(false);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry profile" }));
    await screen.findByRole("button", { name: /^Copy Agent type:/ });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

it("does not report an old clipboard completion on a replacement identifier", async () => {
  const h = setup();
  const user = userEvent.setup();
  let finish!: () => void;
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    render(h.tree(person.pubkey));
    await user.click(
      await screen.findByRole("button", { name: /^Copy NIP-05:/ }),
    );
    await h.emit(
      profile(
        person,
        { name: "Agent", is_agent: true, nip05: "new@example.test" },
        5,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Copy NIP-05:/ }),
      ).toHaveTextContent("new@example.test"),
    );
    await act(async () => finish());
    expect(screen.queryByText("Copied nip-05")).not.toBeInTheDocument();
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

it("applies a verified owner policy live, reserves malformed updates and follows owner removal", async () => {
  const h = setup();
  try {
    render(h.tree(person.pubkey));
    await screen.findByRole("button", { name: /^Copy Agent type:/ });
    const digest = new Uint8Array(
      createHash("sha256")
        .update(`nostr:agent-auth:${person.pubkey}:`)
        .digest(),
    );
    const owned = signed(person, {
      kind: 0,
      content: JSON.stringify({ name: "Agent", is_agent: true }),
      created_at: 10,
      tags: [
        [
          "auth",
          human.pubkey,
          "",
          bytesToHex(schnorr.sign(digest, human.secret)),
        ],
      ],
    });
    const policy = signed(human, {
      kind: 30177,
      content: JSON.stringify({
        name: "Agent",
        parallelism: 4,
        respond_to: "owner-only",
      }),
      tags: [["d", person.pubkey]],
      created_at: 11,
    });
    await h.emit(policy);
    await h.emit(owned);
    await screen.findByRole("region", { name: "Agent identity" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Copy Agent type:/ }),
      ).toHaveTextContent("agent"),
    );
    expect(
      screen.queryByRole("button", { name: /^Copy Capabilities:/ }),
    ).not.toBeInTheDocument();
    await h.emit(signed(human, { ...policy, content: "{}", created_at: 12 }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Copy Agent type:/ }),
      ).not.toBeInTheDocument(),
    );
    await h.emit(profile(person, { name: "Agent", is_agent: true }, 13));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Agent identity" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Copy Agent type:/ }),
      ).toHaveTextContent("Goose"),
    );
    expect(
      screen.getByRole("button", { name: /^Copy Capabilities:/ }),
    ).toHaveTextContent("code, search");
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

for (const runtime of [
  "__proto__",
  "constructor",
  "toString",
  "unknown-runtime",
]) {
  it(`displays and copies the unknown runtime ${runtime} as a raw string`, async () => {
    const h = setup([metadata({ agent_type: runtime })]);
    const user = userEvent.setup();
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    try {
      render(h.tree(person.pubkey));
      const row = await screen.findByRole("button", {
        name: /^Copy Agent type:/,
      });
      expect(row).toHaveTextContent(runtime);
      await user.click(row);
      expect(clipboard).toHaveBeenCalledWith(runtime);
      await screen.findByText("Copied agent type");
    } finally {
      cleanup();
      h.owner.dispose();
    }
  });
}

it("uses one recovery control when profile and public metadata reads fail", async () => {
  const h = setup();
  h.fail("all");
  try {
    render(h.tree(human.pubkey));
    await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Retry profile" }),
    ).toHaveLength(1);
    h.fail(false);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry profile" }));
    await screen.findByRole("heading", { name: "Human" });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry profile" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

it("keeps completed copy feedback after metadata replacement and profile navigation", async () => {
  const h = setup();
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  try {
    const mounted = render(h.tree(person.pubkey));
    await user.click(
      await screen.findByRole("button", { name: /^Copy Capabilities:/ }),
    );
    await screen.findByText("Copied capabilities");
    await h.emit(metadata({ agent_type: "aider", capabilities: [] }, 4));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Copy Capabilities:/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Copied capabilities")).toBeVisible();
    mounted.rerender(h.tree(human.pubkey));
    await screen.findByRole("heading", { name: "Human" });
    expect(screen.getByText("Copied capabilities")).toBeVisible();
  } finally {
    cleanup();
    h.owner.dispose();
  }
});

it("never presents legacy fields while the initial managed profile settles", async () => {
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${person.pubkey}:`).digest(),
  );
  const owned = signed(person, {
    kind: 0,
    content: JSON.stringify({ name: "Agent", is_agent: true }),
    created_at: 10,
    tags: [
      [
        "auth",
        human.pubkey,
        "",
        bytesToHex(schnorr.sign(digest, human.secret)),
      ],
    ],
  });
  const policy = signed(human, {
    kind: 30177,
    content: JSON.stringify({
      name: "Agent",
      parallelism: 4,
      respond_to: "owner-only",
    }),
    tags: [["d", person.pubkey]],
    created_at: 11,
  });
  const h = setup([
    owned,
    policy,
    metadata({ agent_type: "goose", capabilities: ["legacy-only"] }),
  ]);
  const seen: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) seen.push(node.textContent ?? "");
      if (record.type === "characterData")
        seen.push(record.target.textContent ?? "");
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  try {
    render(h.tree(person.pubkey));
    await screen.findByRole("region", { name: "Agent identity" });
    const row = await screen.findByRole("button", {
      name: /^Copy Agent type:/,
    });
    expect(row).toHaveTextContent("agent");
    expect(seen.join(" ")).not.toContain("legacy-only");
    expect(seen.join(" ")).not.toContain("Goose");
  } finally {
    observer.disconnect();
    cleanup();
    h.owner.dispose();
  }
});

it("withholds metadata on ownership-only admission failure and retries through one control", async () => {
  let blocked = true;
  let enrichment: ReturnType<RelaySession["observe"]> | undefined;
  const admission = vi.fn(
    (
      session: RelaySession,
      filters: Parameters<RelaySession["observe"]>[0],
    ) => {
      if (blocked && filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("view capacity exhausted");
      const view = session.observe(filters);
      if (filters.some((filter) => filter.kinds?.includes(10100)))
        enrichment = view;
      return view;
    },
  );
  const h = setup(undefined, (session) =>
    Object.create(session, {
      observe: {
        value: (filters: Parameters<RelaySession["observe"]>[0]) =>
          admission(session, filters),
      },
    }),
  );
  try {
    render(h.tree(person.pubkey));
    await screen.findByRole("heading", { name: "Agent" });
    await screen.findByRole("button", { name: "Retry profile" });
    await waitFor(() => {
      expect(enrichment?.snapshot().status).toBe("ready");
      expect(
        enrichment?.snapshot().events.some((event) => event.kind === 10100),
      ).toBe(true);
    });
    expect(
      screen.queryByRole("button", { name: /^Copy Agent type:/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Copy Capabilities:/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Retry profile" }),
    ).toHaveLength(1);
    blocked = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry profile" }));
    expect(
      await screen.findByRole("button", { name: /^Copy Agent type:/ }),
    ).toHaveTextContent("Goose");
    expect(
      screen.getByRole("button", { name: /^Copy Capabilities:/ }),
    ).toHaveTextContent("code, search");
    expect(
      screen.queryByRole("button", { name: "Retry profile" }),
    ).not.toBeInTheDocument();
  } finally {
    cleanup();
    h.owner.dispose();
  }
});
