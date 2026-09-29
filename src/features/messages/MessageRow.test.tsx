// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import { expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
} from "@testing-library/react";
import { messageCopyText } from "./message-copy";
import { profileTarget } from "../profiles/target";
import { renderToStaticMarkup } from "react-dom/server";
import { foldMessages } from "../relay/fold";
import { keypair, message, signed, summary } from "../relay/testing";
import { MessageRow } from "./MessageRow";
import type { ChannelMessage } from "../relay/contracts";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";
import type { RelaySession } from "../relay/session";
import { LinkLabel } from "../../bundled/links/InlineLink";

vi.mock("../../shared/design-system/ui/agent-thinking/ThinkingBadge", () => ({
  ThinkingBadge: ({ children }: { children: React.ReactNode }) => (
    <span className="badge-pill-root">{children}</span>
  ),
}));

const row: ChannelMessage = {
  id: "root",
  channelId: "channel",
  authorId: "author",
  content: "Root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 23,
};

it.each([false, true])(
  "carries agent-envelope appearance into avatar navigation: %s",
  (agentEnvelope) => {
    const authorId = "ab".repeat(32);
    const open = vi.fn(() => true);
    try {
      renderDom(
        <MessageRow
          row={{
            ...row,
            authorId,
            ...(agentEnvelope ? { agentEnvelope: true as const } : {}),
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: `View ${authorId.slice(0, 10)} profile`,
        }),
      );
      expect(open).toHaveBeenCalledWith(
        profileTarget(authorId, { agent: agentEnvelope }),
      );
    } finally {
      cleanup();
    }
  },
);

it("keeps agent badges but omits human presence and status symbols from messages", () => {
  const agentRow = { ...row, authorId: "a".repeat(64) };
  const subscribe = vi.fn(() => () => {});
  const status = vi.fn<() => "online" | "unknown">(() => "online");
  const channels = { channels: [], status: "ready" };
  let working = false;
  const activityListeners = new Set<() => void>();
  const session = {
    agentActivity: {
      snapshot: () => ({
        turns: working
          ? [
              {
                agent: agentRow.authorId,
                channelId: row.channelId,
                state: "working",
              },
            ]
          : [],
        typing: [],
      }),
      subscribe: (listener: () => void) => {
        activityListeners.add(listener);
        return () => {
          activityListeners.delete(listener);
        };
      },
    },
    presence: { subscribe, status, limited: () => false },
    messages: { report: undefined },
    channels: {
      subscribeList: () => () => {},
      list: () => channels,
    },
  } as unknown as RelaySession;
  const show = (agent: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={agentRow}
        agentPubkeys={agent ? new Set([agentRow.authorId]) : undefined}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
  const agent = show(true);
  expect(agent).toContain('class="badge-pill-root"');
  expect(agent).toContain('aria-label="Agent, available"');
  const human = show(false);
  expect(human).not.toContain('data-status="online"');
  expect(human).not.toContain("data-compact");
  expect(status).toHaveBeenCalledTimes(1);
  const props = {
    row: agentRow,
    session,
    profile: undefined,
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
  };
  const mounted = renderDom(
    <MessageRow {...props} agentPubkeys={new Set([agentRow.authorId])} />,
  );
  expect(subscribe).toHaveBeenCalledWith(
    agentRow.authorId,
    expect.any(Function),
    false,
  );
  mounted.rerender(
    <MessageRow
      {...props}
      agentPubkeys={new Set([agentRow.authorId])}
      canOpenLink={() => true}
    />,
  );
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription(/^Presence: online\s*$/);
  act(() => {
    working = true;
    for (const listener of activityListeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription("Presence: online Agent is thinking");
  expect(document.querySelector(".agent-motion-avatar")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  act(() => {
    working = false;
    for (const listener of activityListeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription(/^Presence: online\s*$/);
  mounted.unmount();
  status.mockReturnValue("unknown");
  const unknown = renderDom(<MessageRow {...props} canOpenLink={() => true} />);
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).not.toHaveAccessibleDescription();
  unknown.unmount();
  subscribe.mockClear();
  renderDom(<MessageRow {...props} />);
  expect(subscribe).not.toHaveBeenCalled();
  cleanup();
});
it.each(["bare", "angle", "markdown", "escaped"] as const)(
  "renders link contributions inside message prose, preserving punctuation and plain-link fallback (%s)",
  (format) => {
    const url = "https://github.com/block/buzz/issues/1234";
    const label =
      format === "markdown" || format === "escaped" ? "Repository" : url;
    const content = {
      bare: url,
      angle: `<${url}>`,
      markdown: `[Repository](${url})`,
      escaped: `[Repository]\\([${url}](${url}))`,
    }[format];
    const entry = {
      id: "link",
      title: "Link",
      key: "buzz.links/link",
      pluginId: "buzz.links",
      revision: "one",
      matches: () => true,
      component: ({ url }: { url: string }) => <LinkLabel href={url} />,
    };
    const render = (enabled: boolean) =>
      renderToStaticMarkup(
        <MessageRow
          row={{
            ...row,
            content: `Before ${content}. After`,
            replyCount: 0,
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          extensions={{
            tools: { snapshot: () => [], subscribe: () => () => {} },
            inline: { snapshot: () => [], subscribe: () => () => {} },
            links: {
              snapshot: () => (enabled ? [entry] : []),
              subscribe: () => () => {},
            },
          }}
        />,
      );
    const enabled = render(true);
    expect(enabled).toContain(`href="${url}"`);
    expect(enabled).toContain('data-link-kind="github"');
    expect(enabled.replace(/<[^>]+>/g, "")).toContain(`Before ${label}. After`);
    expect(enabled).not.toContain("&lt;");
    expect(enabled).not.toContain("&gt;");
    expect(render(false)).not.toContain("data-link-kind");
    expect(render(false)).toContain(`>${label}</a>`);
  },
);

it.each([
  ["😀 🙏 👏", [], true],
  ["😀 🙏 👏 😄", [], true],
  ["😀".repeat(40), [], true],
  [
    ":party: ".repeat(24),
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  [
    ":party: 😀 :party: 😀",
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  ["😀 🙏 👏 😄 hello", [], false],
  [":unknown: 😀", [], false],
  ["  \n  ", [], false],
] as const)(
  "keeps emoji-only message size independent of count: %s",
  (content, emoji, large) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, emoji }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.includes('data-single-emoji="true"')).toBe(large);
  },
);
function render(
  patch: Partial<UnreadSnapshot>,
  replies = 23,
  clickable = true,
  threadRootId?: string,
) {
  const snapshot = vi.fn(() => ({
    observedCount: null,
    manual: "none",
    ...patch,
  }));
  const unread = { snapshot } as unknown as UnreadCapability;
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, replyCount: replies, threadRootId }}
      unread={unread}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={clickable ? () => {} : undefined}
    />,
  );
  return { html, snapshot };
}
it("renders the signed whole-thread total rather than only direct replies", () => {
  const author = keypair(),
    relay = keypair();
  const root = message(author, "channel", "Root", 1);
  const [folded] = foldMessages("channel", relay.pubkey, [
    root,
    summary(relay, "channel", root.id, {
      reply_count: 1,
      descendant_count: 3,
      participants: [author.pubkey],
    }),
  ]);
  if (!folded) throw new Error("Missing root");
  const html = renderToStaticMarkup(
    <MessageRow
      row={folded}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={() => {}}
    />,
  );
  expect(html).toContain('aria-label="View thread: 3 replies"');
  expect(html).toContain("3 replies</span>");
});
it("selects this thread, adds an accessible unread cue and preserves the total reply count", () => {
  const { html, snapshot } = render({ observedCount: 2 });
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "root",
  });
  expect(html).toContain(
    'aria-label="View thread: 23 replies. Observed unread replies. Not an exact total."',
  );
  expect(html).toContain(
    'aria-hidden="true" title="Observed unread replies. Not an exact total."',
  );
  expect(html).toContain("23 replies</span>");
});
it.each([null, 0])(
  "omits the dot for %s observed replies, not a fabricated unread total",
  (observedCount) => {
    const { html } = render({ observedCount });
    expect(html).toContain('aria-label="View thread: 23 replies"');
    expect(html).not.toContain("title=");
  },
);
it("describes local manual intent and stale evidence honestly", () => {
  expect(render({ manual: "local-only", observedCount: 0 }).html).toContain(
    "Thread marked unread on this device only",
  );
  expect(render({ manual: "remote", observedCount: 0 }).html).toContain(
    "Thread marked unread",
  );
  expect(render({ observedCount: 1, freshness: "stale" }).html).toContain(
    "Observed unread replies; may be out of date",
  );
});
it("does not select unread for rows without a thread button", () => {
  expect(render({}, 0).snapshot).not.toHaveBeenCalled();
  expect(render({}, 23, false).snapshot).not.toHaveBeenCalled();
});

it("selects the opening root for a broadcast reply instead of its own row ID", () => {
  const { snapshot } = render({ observedCount: 1 }, 23, true, "original-root");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "original-root",
  });
});

it("renders exact identity controls only while a target can be opened", () => {
  const author = "a".repeat(64),
    recipient = "b".repeat(64);
  const renderProfile = (enabled: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          authorId: author,
          content: "Hello @Mic",
          mentions: [recipient],
        }}
        profile={{ name: "Author" }}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => enabled}
        day={false}
        retry={undefined}
      />,
    );
  const enabled = renderProfile(true);
  expect(enabled).toContain('aria-label="View Author profile"');
  expect(enabled).toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain(
    'aria-label="View Author profile"',
  );
  expect(renderProfile(false)).toContain("@Mic");
});

it.each([
  "    @Mic\n\nOutside @Mic",
  '```js\nconst delimiter = "```";\n@Mic\n```\nOutside @Mic',
  "~~~js\nconst delimiter = '~~~';\n@Mic\n~~~\nOutside @Mic",
])("only exposes the prose mention through MessageRow: %s", (content) => {
  const recipient = "b".repeat(64);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, content, mentions: [recipient] }}
      profile={undefined}
      participantProfiles={new Map([[recipient, { name: "Mic" }]])}
      media={() => undefined}
      onOpenLink={() => true}
      canOpenLink={() => true}
      day={false}
      retry={undefined}
    />,
  );
  expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
  expect(html.indexOf('aria-label="View Mic profile"')).toBeGreaterThan(
    html.indexOf("Outside "),
  );
});

it.each([9, 40002])(
  "does not manufacture profile bindings when kind %s images are removed",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of [
      "@M![x][image]ic\n\n[image]: https://example.test/a.png",
      "@M![x](https://example.test/a.png)ic",
      "@M![x](http://example.test/a.png)ic",
      "@![x](https://example.test/a.png)Mic",
      "Hello @Mic ![x](https://example.test/a.png)",
    ]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      expect(folded.content).toContain("@Mic");
      expect(folded.attachmentContentRemoved).toBe(true);
      expect(folded.mentions).toEqual([recipient.pubkey]);
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(html).toContain("@Mic");
    }
    const [unchanged] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", "@Mic  \n", 1),
    ]);
    expect(unchanged?.attachmentContentRemoved).toBeUndefined();
  },
);

it.each([9, 40002])(
  "preserves signed kind %s code indentation through fold and render",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of ["    @Mic", "\t@Mic"]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(folded.content).toBe(content);
    }
  },
);

it.each([
  { width: 700, height: 900 },
  { width: 1600, height: 900 },
  { width: 20, height: 10 },
])("uses fixed thumbnails regardless of image dimensions: %j", (dimensions) => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { url: "https://image.test/shot.png", kind: "image", dimensions },
        ],
      }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('data-thumbnail="true"');
  expect(html).not.toContain("aspect-ratio:");
  expect(html).toContain('aria-label="Open image attachment"');
  expect(html).toContain('loading="lazy"');
});

it.each([undefined, { width: 640, height: 400 }])(
  "keeps cached images silent and unfetched, but explains a live unavailable source (%j)",
  (dimensions) => {
    const media = vi.fn(() => undefined);
    const imageRow: ChannelMessage = {
      ...row,
      attachments: [
        {
          url: "https://image.test/unavailable.png",
          kind: "image",
          ...(dimensions ? { dimensions } : {}),
        },
      ],
    };
    const show = (cached: boolean) => {
      const list = {
        status: "ready",
        channels: [{ id: row.channelId, cached }],
      };
      const session = {
        messages: {},
        channels: { list: () => list, subscribeList: () => () => {} },
      } as unknown as RelaySession;
      return (
        <MessageRow
          row={imageRow}
          session={session}
          profile={undefined}
          media={media}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      );
    };
    const view = renderDom(show(true));
    try {
      const placeholder = view.container.querySelector(
        '[class*="attachmentImage"][aria-hidden="true"]',
      );
      expect(placeholder).not.toBeNull();
      expect(placeholder).toBeEmptyDOMElement();
      expect(placeholder).toHaveAttribute("data-thumbnail", "true");
      expect(placeholder).not.toHaveAttribute("style"); // Strip CSS owns fixed geometry.
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(screen.queryByText("Image unavailable")).not.toBeInTheDocument();
      view.rerender(show(false));
      expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
      expect(
        view.container.querySelector('[class*="attachmentImage"]'),
      ).toBeNull();
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(media).toHaveBeenCalledWith("https://image.test/unavailable.png");
    } finally {
      view.unmount();
    }
  },
);

it("does not bypass the session media resolver to paint an inaccessible attachment", () => {
  const media = vi.fn(() => undefined);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://image.test/original.png",
            kind: "image",
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          },
        ],
      }}
      profile={undefined}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(media).toHaveBeenCalledWith("https://image.test/original.png");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");
});

it("uses the reviewed SVG squircle only for identities classified as agents", () => {
  const agent = "a".repeat(64);
  const media = vi.fn((url: string) => url);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, authorId: agent }}
      profile={{ name: "Carl", picture: "https://image.test/agent.png" }}
      agentPubkeys={new Set([agent])}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('data-avatar-shape="squircle"');
  expect(media).toHaveBeenCalledWith("https://image.test/agent.png", "small");
  expect(render({}, 0).html).toContain('data-avatar-shape="circle"');
});

it.each([9, 40002])(
  "renders kind %s author shape from the existing fold without profile/library evidence",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const [folded] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content:
          kind === 40002 ? JSON.stringify({ content: "Reply" }) : "Reply",
        tags: [["h", "channel"]],
      }),
    ]);
    if (!folded) throw new Error("Missing row");
    const html = renderToStaticMarkup(
      <MessageRow
        row={folded}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(
      `data-avatar-shape="${kind === 40002 ? "squircle" : "circle"}"`,
    );
  },
);

it("requests a small profile image without downsizing message attachments", () => {
  const media = vi.fn((url: string) => url);
  renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { url: "https://image.test/attachment.png", kind: "image" },
        ],
      }}
      profile={{ name: "Author", picture: "https://image.test/avatar.png" }}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );

  expect(media).toHaveBeenCalledWith("https://image.test/avatar.png", "small");
  expect(media).toHaveBeenCalledWith("https://image.test/attachment.png");
});

it("renders generic file attachments as download cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/report.pdf",
            kind: "file",
            name: "report.pdf",
            size: 1536,
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain(
    'href="/api/relay/media?url=https%3A%2F%2Ffiles.test%2Freport.pdf"',
  );
  expect(html).toContain('download="report.pdf"');
  expect(html).toContain('aria-label="Download report.pdf"');
  expect(html).toContain("report.pdf");
  expect(html).toContain("2 KB");
  expect(html).not.toContain("Open image attachment");
  expect(html).not.toContain("<img");
});

it("renders unavailable generic files without a download link", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/missing.pdf",
            kind: "file",
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("PDF file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector("a")).toBeNull();
  expect(html).not.toContain("Open image attachment");
});

it("renders proxy audio attachments with an inline player", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            duration: 12,
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Play audio"');
  expect(html).toContain('aria-label="Seek audio"');
  expect(html).toContain("0:00 / 0:12");
  expect(html).not.toContain("Download file");
});

it("renders external audio sources as open file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            name: "audio.mp3",
          },
        ],
      }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Open audio.mp3"');
  expect(html).toContain("Open file");
  expect(html).not.toContain('aria-label="Play audio"');
});

it("renders missing audio sources as unavailable file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            mime: "audio/mpeg",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("MPEG file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  expect(html).not.toContain('aria-label="Play audio"');
});

it.each([9, 40002])(
  "preserves copied kind %s identities through resend, fold, and profile opening without adding recipients",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const people = [keypair(), keypair()];
    const profiles = new Map(
      people.map(({ pubkey }) => [pubkey, { name: "Morgan" }]),
    );
    const copies = people.map(({ pubkey }) => {
      const [original] = foldMessages("channel", relay.pubkey, [
        signed(author, {
          kind,
          content:
            kind === 40002
              ? JSON.stringify({ content: "Hello @Morgan" })
              : "Hello @Morgan",
          tags: [
            ["h", "channel"],
            ["p", pubkey],
          ],
        }),
      ]);
      if (!original) throw new Error("missing original");
      return messageCopyText(original, profiles, []);
    });
    const content = copies.join(" and ");
    const [resent] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [["h", "channel"]],
      }),
    ]);
    if (!resent) throw new Error("missing resent message");
    expect(resent.mentions).toEqual([]);
    expect(messageCopyText(resent, profiles, [])).toBe(content);
    const open = vi.fn((_target: string) => true);
    try {
      renderDom(
        <MessageRow
          row={resent}
          profile={undefined}
          participantProfiles={profiles}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      const references = screen.getAllByRole("button", {
        name: "View Morgan profile",
      });
      expect(references).toHaveLength(2);
      references.forEach((reference) => {
        fireEvent.click(reference);
        expect(document.activeElement).toBe(reference);
      });
      expect(open.mock.calls).toEqual(
        people.map(({ pubkey }) => [profileTarget(pubkey)]),
      );
      expect(resent.mentions).toEqual([]);
    } finally {
      cleanup();
    }
  },
);

it.each([
  { replyCount: 0, threadRootId: undefined, expected: false, count: 1 },
  { replyCount: 2, threadRootId: undefined, expected: true, count: 1 },
  { replyCount: 0, threadRootId: "parent", expected: true, count: 1 },
  { replyCount: 2, threadRootId: undefined, expected: true, count: 2 },
])(
  "passes known comment state from the chat photo to its viewer: $expected",
  ({ replyCount, threadRootId, expected, count }) => {
    const attachment = {
      kind: "image" as const,
      url: "https://fixture.test/photo.png",
    };
    const open = vi.fn();
    renderDom(
      <MessageRow
        row={{
          ...row,
          attachments:
            count === 1
              ? [attachment]
              : [
                  attachment,
                  { ...attachment, url: "https://fixture.test/second.png" },
                ],
          replyCount,
          ...(threadRootId ? { threadRootId } : {}),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        onOpenMediaReview={open}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("link", {
        name: count === 1 ? "Open image attachment" : "Open image 1 of 2",
      }),
      { detail: 1 },
    );
    expect(open).toHaveBeenCalledWith(row.id, attachment, 0, expected);
    cleanup();
  },
);

it.each(["sending", "failed"] as const)(
  "does not leave an orphan menu separator on a %s own message",
  async (delivery) => {
    const snapshot = { channels: [], status: "ready" };
    const session = {
      viewer: row.authorId,
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      messages: {},
      unread: { subscribe: () => () => {}, snapshot: () => undefined },
    } as unknown as RelaySession;
    renderDom(
      <MessageRow
        row={{ ...row, delivery }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Copy message"]);
      expect(screen.queryByRole("separator")).toBeNull();
    } finally {
      cleanup();
    }
  },
);

// These contracts belong to the rendered row, rather than a shallow ThreadPanel fixture.
function renderMessage(
  patch: Partial<import("./MessageRow").MessageRowProps> = {},
) {
  return renderDom(
    <MessageRow
      row={row}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      {...patch}
    />,
  );
}

it("rejects attachment URLs outside the shared safe-link policy", () => {
  const media = vi.fn((url: string) => url);
  const view = renderMessage({
    row: {
      ...row,
      attachments: [
        { url: "https://safe.test/a.png", kind: "image" },
        { url: "https://user:secret@unsafe.test/a.png", kind: "image" },
        { url: "http://unsafe.test/a.png", kind: "image" },
      ],
    },
    media,
  });
  try {
    const links = screen.getAllByRole("link", {
      name: "Open image attachment",
    });
    expect(media).toHaveBeenCalledExactlyOnceWith("https://safe.test/a.png");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://safe.test/a.png");
    expect(view.container.innerHTML).not.toContain("unsafe.test");
  } finally {
    view.unmount();
  }
});

it.each([true, false])(
  "renders a stripped timecode body with seeking available=%s",
  (canSeek) => {
    const seek = vi.fn();
    const view = renderMessage({
      row: { ...row, content: "⏱ 0:42 — **Change** the title" },
      ...(canSeek ? { onMediaTime: seek } : {}),
    });
    try {
      expect(screen.getByText("Change").tagName).toBe("STRONG");
      expect(view.container).toHaveTextContent("Change the title");
      expect(view.container.textContent?.match(/0:42/g)).toHaveLength(1);
      expect(view.container).not.toHaveTextContent("⏱");
      if (canSeek) {
        fireEvent.click(screen.getByRole("button", { name: "0:42" }));
        expect(seek).toHaveBeenCalledExactlyOnceWith(42);
      } else {
        expect(screen.queryByRole("button", { name: "0:42" })).toBeNull();
        expect(screen.getByText("0:42").tagName).toBe("SPAN");
      }
    } finally {
      view.unmount();
    }
  },
);

it.each([undefined, "canonical-root"])(
  "opens the selected row with canonical root %s and retains trigger focus",
  (threadRootId) => {
    const open = vi.fn();
    const view = renderMessage({
      row: { ...row, threadRootId },
      onOpenThread: open,
    });
    try {
      const trigger = screen.getByRole("button", {
        name: "View thread: 23 replies",
      });
      fireEvent.click(trigger);
      expect(trigger).toHaveFocus();
      expect(open).toHaveBeenCalledExactlyOnceWith(
        row.id,
        threadRootId ?? row.id,
      );
    } finally {
      view.unmount();
    }
  },
);

it("bounds reply participants and projects artwork with fallback initials", () => {
  const media = vi.fn((url: string) =>
    url === "https://safe/avatar" ? "https://proxy/avatar" : undefined,
  );
  const view = renderMessage({
    row: { ...row, participants: ["p1", "p2", "p3", "p4", "p5"] },
    participantProfiles: new Map([
      ["p1", { name: "Alice", picture: "https://safe/avatar" }],
      ["p2", { name: "Brain", picture: "http://unsafe" }],
    ]),
    media,
    onOpenThread: () => {},
  });
  try {
    const trigger = screen.getByRole("button", {
      name: "View thread: 23 replies",
    });
    expect(
      [...trigger.querySelectorAll("[title]")].map((e) =>
        e.getAttribute("title"),
      ),
    ).toEqual(["Alice", "Brain", "p3"]);
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      "https://proxy/avatar",
    );
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    expect(trigger.querySelector('[title="Brain"]')).toHaveTextContent("B");
    expect(trigger.querySelector('[title="p3"]')).toHaveTextContent("P");
    expect(trigger).toHaveTextContent("+2");
    expect(media).toHaveBeenCalledWith("https://safe/avatar", "small");
    expect(media).toHaveBeenCalledWith("http://unsafe", "small");
  } finally {
    view.unmount();
  }
});

it.each([1, 2, 3, 4, 5, 10])(
  "keeps all %i images reachable in a labelled strip",
  (count) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: Array.from({ length: count }, (_, i) => ({
            kind: "image",
            url: `https://image.test/${i}.png`,
          })),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(
      `role="group" aria-label="${count} ${count === 1 ? "image" : "images"}"`,
    );
    expect(html.match(/data-thumbnail="true"/g)).toHaveLength(count);
    expect(html).toContain(`href="https://image.test/${count - 1}.png"`);
    const text = new DOMParser().parseFromString(html, "text/html").body
      .textContent;
    if (count === 1) expect(text).not.toContain("1 image");
    else expect(text).toContain(`${count} images`);
  },
);

it("preserves interleaved file order and counts unavailable images but not unsafe URLs", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { kind: "image", url: "https://image.test/first.png" },
          { kind: "image", url: "javascript:alert(1)" },
          { kind: "image", url: "https://image.test/unavailable.png" },
          {
            kind: "file",
            url: "https://files.test/notes.md",
            name: "notes.md",
          },
          { kind: "image", url: "https://image.test/last.png" },
        ],
      }}
      profile={undefined}
      media={(url) => (url.includes("unavailable") ? undefined : url)}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('role="group" aria-label="2 images"');
  expect(html).toContain('role="group" aria-label="1 image"');
  const text = new DOMParser().parseFromString(html, "text/html").body
    .textContent;
  expect(text).toContain("2 images");
  expect(text).not.toContain("1 image");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("javascript:");
  expect(html.indexOf('href="https://image.test/first.png"')).toBeLessThan(
    html.indexOf('href="https://files.test/notes.md"'),
  );
  expect(html.indexOf('href="https://files.test/notes.md"')).toBeLessThan(
    html.indexOf('href="https://image.test/last.png"'),
  );
});

it("keeps audio and video players between their original image runs", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { kind: "image", url: "https://image.test/first.png" },
          {
            kind: "audio",
            url: "https://files.test/voice.mp3",
            name: "voice.mp3",
          },
          {
            kind: "video",
            url: "https://files.test/demo.mp4",
            name: "demo.mp4",
          },
          { kind: "image", url: "https://image.test/last.png" },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html.match(/role="group" aria-label="1 image"/g)).toHaveLength(2);
  expect(html).toContain("<audio");
  expect(html).toContain("<video");
  expect(html.indexOf('href="https://image.test/first.png"')).toBeLessThan(
    html.indexOf("<audio"),
  );
  expect(html.indexOf("<audio")).toBeLessThan(html.indexOf("<video"));
  expect(html.indexOf("<video")).toBeLessThan(
    html.indexOf('href="https://image.test/last.png"'),
  );
});

it.each([true, false])(
  "uses the shared small avatar without shrinking profile controls (clickable=%s)",
  (clickable) => {
    const props = {
      row: { ...row, authorId: "a".repeat(64) },
      profile: undefined,
      media: () => undefined,
      onOpenLink: () => false,
      canOpenLink: () => clickable,
      day: false,
      retry: undefined,
      layout: "thread" as const,
    };
    const view = renderDom(<MessageRow {...props} compactAvatar />);
    expect(view.container.querySelector(".buzz-avatar")).toHaveAttribute(
      "data-size",
      "small",
    );
    if (clickable) {
      expect(
        view.getByRole("button", { name: "View aaaaaaaaaa profile" }),
      ).toHaveAttribute("data-size", "sm");
    }
    view.rerender(<MessageRow {...props} />);
    expect(view.container.querySelector(".buzz-avatar")).toHaveAttribute(
      "data-size",
      clickable ? "fill" : "default",
    );
    view.unmount();
  },
);
