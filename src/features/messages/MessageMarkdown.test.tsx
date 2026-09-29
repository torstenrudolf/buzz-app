// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { LockIcon, RobotIcon } from "../../shared/design-system/icons/index";
import referenceStyles from "../../shared/InlineReference.module.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ComponentProps } from "react";
import type {
  ConversationExtensions,
  InlineRenderer,
} from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import { CustomEmoji } from "../../bundled/emoji/CustomEmoji";
import { emojiMatches } from "../relay/emoji";
import { profileTarget } from "../profiles/target";
import styles from "./Messages.module.css";
import { LinkLabel } from "../../bundled/links/InlineLink";
import { MessageMarkdown } from "./MessageMarkdown";
import { createRelaySession } from "../relay/session";
import { createAgentDirectory } from "../identity-names/testing";
import { bindNames } from "../identity-names/service";
import * as messageContent from "../relay/message-content";
import { MAX_MARKDOWN_LENGTH, safeMessageUrl } from "../relay/message-content";
import type { ChannelMessage } from "../relay/contracts";

const markdownRenders = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (properties: ComponentProps<typeof actual.default>) => {
      markdownRenders();
      const Markdown = actual.default;
      return <Markdown {...properties} />;
    },
  };
});

const mic = "b".repeat(64),
  smith = "a".repeat(64),
  other = "c".repeat(64);
const profiles = new Map([
  [mic, { name: "Mic" }],
  [smith, { name: "Mic Smith" }],
  [other, { name: "Other" }],
]);
type RenderOptions = Partial<
  Omit<ComponentProps<typeof MessageMarkdown>, "row">
> & {
  emoji?: ChannelMessage["emoji"];
  patch?: Partial<ChannelMessage>;
};
function props(
  content: string,
  { emoji = [], patch, ...options }: RenderOptions = {},
): ComponentProps<typeof MessageMarkdown> {
  return {
    row: {
      id: "message",
      channelId: "channel",
      authorId: "author",
      content,
      createdAt: 1,
      mentions: [mic, smith],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      emoji,
      ...patch,
    },
    media: () => undefined,
    onOpenLink: () => false,
    canOpenLink: () => true,
    participantProfiles: profiles,
    ...options,
  };
}
function render(content: string, options: RenderOptions = {}) {
  return renderToStaticMarkup(<MessageMarkdown {...props(content, options)} />);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const party = {
  shortcode: "party_parrot",
  url: "https://emoji.test/party.png",
};
const emojiRenderer: Contribution<InlineRenderer> = {
  id: "emoji",
  key: "test/emoji",
  pluginId: "test",
  revision: "1",
  title: "Emoji",
  matches: ({ text, message }) => [...emojiMatches(text, message.emoji ?? [])],
  component: ({ media }) => <CustomEmoji emoji={party} media={media} />,
};
const pluginRenderer: Contribution<InlineRenderer> = {
  id: "word",
  key: "test/word",
  pluginId: "test",
  revision: "1",
  title: "Word",
  matches: ({ text }) =>
    [...text.matchAll(/PLUGIN/g)].map((match) => ({
      start: match.index,
      end: match.index + 6,
    })),
  component: ({ text }) => <mark>{text}</mark>,
};
const inlineRenderers = [emojiRenderer, pluginRenderer] as const;
const extensions: ConversationExtensions = {
  tools: { snapshot: () => [], subscribe: () => () => {} },
  inline: {
    snapshot: () => inlineRenderers,
    subscribe: () => () => {},
  },
};

describe("MessageMarkdown", () => {
  it("renders compact CommonMark and GFM structure with chat line breaks", () => {
    const html = render(`# Heading
first
second

- one
- two

~~done~~

> quote

| A | B |
| - | - |
| 1 | 2 |

- [x] checked`);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("first<br/>\nsecond");
    expect(html).toContain("<ul>");
    expect(html).toContain("<del>done</del>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
  });

  it("renders inline and fenced code without parsing markdown inside it", () => {
    const html = render("`**literal** :party:`\n\n```ts\nconst x = 1\n```");
    expect(html).toContain("<code>**literal** :party:</code>");
    expect(html).toContain('<code class="language-ts">const x = 1');
    expect(html).not.toContain("<strong>literal</strong>");
  });

  it("keeps raw HTML inert and never renders markdown images", () => {
    const html = render(
      '<script>alert("x")</script>\n\nbefore <b>raw</b> ![remote alt](https://images.test/a.png)',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("remote alt");
  });

  it("allows credential-free HTTPS links and makes other destinations non-clickable", () => {
    expect(safeMessageUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/x",
      "/relative",
      "https://user:secret@example.com",
    ])
      expect(safeMessageUrl(url)).toBeUndefined();

    const safe = render("[Example](https://example.com/path)");
    expect(safe).toContain('href="https://example.com/path"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('title="https://example.com/path"');

    const unsafe = render("[bad](javascript:alert(1)) [local](/relative)");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).toContain("bad");
    expect(unsafe).toContain("local");
  });

  it("falls back to literal text before recursively rendering deeply nested inbound content", () => {
    const html = render(`${"> ".repeat(20_000)}**literal deep message**`);
    expect(html).toContain("**literal deep message**");
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain("<strong>");
  });

  it("falls back to literal text for exceptionally large inbound content", () => {
    const html = render(`${"a".repeat(100_001)} **not parsed**`);
    expect(html).toContain("**not parsed**");
    expect(html).not.toContain("<strong>");
  });
});

describe("mounted Markdown preparation", () => {
  it("reuses pure preparation for equivalent rows and invalidates for edited text", () => {
    const scan = vi.spyOn(messageContent, "scanMarkdown");
    const initial = props("**first**");
    const view = renderDom(
      <StrictMode>
        <MessageMarkdown {...initial} />
      </StrictMode>,
    );
    const initialScans = scan.mock.calls.length;
    const initialRenders = markdownRenders.mock.calls.length;
    expect(initialScans).toBeGreaterThan(0);
    expect(initialRenders).toBeGreaterThan(0);
    expect(screen.getByText("first")).toHaveTextContent("first");

    view.rerender(
      <StrictMode>
        <MessageMarkdown
          {...initial}
          row={{
            ...initial.row,
            delivery: "seen",
            reactions: [{ content: "👍", events: [] }],
          }}
        />
      </StrictMode>,
    );
    expect(scan).toHaveBeenCalledTimes(initialScans);
    expect(markdownRenders).toHaveBeenCalledTimes(initialRenders);

    view.rerender(
      <StrictMode>
        <MessageMarkdown
          {...initial}
          row={{ ...initial.row, content: "_second_" }}
        />
      </StrictMode>,
    );
    expect(scan.mock.calls.length).toBeGreaterThan(initialScans);
    expect(markdownRenders.mock.calls.length).toBeGreaterThan(initialRenders);
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.queryByText("first")).not.toBeInTheDocument();
  });

  it("updates live plugin, media, directory, and interactivity inputs without reparsing", () => {
    const metadataRenderer: Contribution<InlineRenderer> = {
      id: "metadata",
      key: "test/metadata",
      pluginId: "test",
      revision: "1",
      title: "Metadata",
      matches: ({ text }) =>
        text === "PLUGIN" ? [{ start: 0, end: text.length }] : [],
      component: ({ content, media }) => (
        <mark>{`${content.message.replyCount}:${media("asset") ?? "none"}`}</mark>
      ),
    };
    const metadataRenderers = [metadataRenderer] as const;
    const liveExtensions: ConversationExtensions = {
      ...extensions,
      inline: {
        snapshot: () => metadataRenderers,
        subscribe: () => () => {},
      },
    };
    const url = "buzz://channel/design";
    const initial = props(`<${url}>\n\nPLUGIN`, {
      extensions: liveExtensions,
      media: () => "first-media",
      directory: {
        profiles: new Map(),
        agents: [],
        channels: [{ id: "design", name: "first", channelType: "forum" }],
      },
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    const initialRenders = markdownRenders.mock.calls.length;
    expect(screen.getByRole("link", { name: "#first" })).toBeInTheDocument();
    expect(screen.getByText("0:first-media")).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, replyCount: 7 }}
        media={() => "second-media"}
        interactive={false}
        directory={{
          profiles: new Map(),
          agents: [],
          channels: [{ id: "design", name: "second", channelType: "forum" }],
        }}
      />,
    );
    expect(markdownRenders).toHaveBeenCalledTimes(initialRenders);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("#second")).toBeInTheDocument();
    expect(screen.getByText("7:second-media")).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, replyCount: 8 }}
        extensions={undefined}
      />,
    );
    expect(markdownRenders).toHaveBeenCalledTimes(initialRenders);
    expect(screen.queryByText("7:second-media")).not.toBeInTheDocument();
    expect(screen.getByText("PLUGIN")).toBeInTheDocument();
  });

  it("invalidates protected prose when live identity and security inputs change", () => {
    const initial = props("@Mic and @Renamed", {
      patch: { mentions: [mic] },
      participantProfiles: new Map([[mic, { name: "Mic" }]]),
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    expect(
      screen.getByRole("button", { name: "View Mic profile" }),
    ).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        participantProfiles={new Map([[mic, { name: "Renamed" }]])}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "View Mic profile" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View Renamed profile" }),
    ).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, edited: true }}
        participantProfiles={new Map([[mic, { name: "Renamed" }]])}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, attachmentContentRemoved: true }}
        participantProfiles={new Map([[mic, { name: "Renamed" }]])}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("invalidates event-local emoji bindings without retaining stale media", () => {
    const initial = props(":party_parrot:", {
      emoji: [party],
      extensions,
      media: () => "https://media.test/first.png",
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://media.test/first.png",
    );

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, emoji: [] }}
        media={() => "https://media.test/stale.png"}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(":party_parrot:")).toBeInTheDocument();
  });

  it("crosses long and deep fallback boundaries after mount", () => {
    const view = renderDom(<MessageMarkdown {...props("**parsed**")} />);
    expect(screen.getByText("parsed").tagName).toBe("STRONG");

    view.rerender(
      <MessageMarkdown
        {...props(`${"a".repeat(MAX_MARKDOWN_LENGTH + 1)} **literal**`)}
      />,
    );
    expect(screen.getByText(/\*\*literal\*\*/)).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown {...props(`${"> ".repeat(20_000)}**deep**`)} />,
    );
    expect(screen.getByText(/\*\*deep\*\*/)).toBeInTheDocument();

    view.rerender(<MessageMarkdown {...props("**parsed again**")} />);
    expect(screen.getByText("parsed again").tagName).toBe("STRONG");
  });
});

describe("Markdown profile mentions", () => {
  it("binds exact signed names longest-first through surrounding emphasis", () => {
    const html = render("**@Mic Smith**, _@Mic_! @Other @Missing @Microscopic");
    expect(html).toContain("<strong><button");
    expect(html).toContain('aria-label="View Mic Smith profile"');
    expect(html).toContain("</svg>Mic Smith</button></strong>");
    // The raw helper conservatively treats trailing underscore as a name suffix.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("<em>@Mic</em>");
    const emphasized = render("*@Mic* ~~@Mic Smith~~");
    expect(emphasized).toContain("<em><button");
    expect(emphasized).toContain("<del><button");
  });

  it("keeps Markdown punctuation within a signed display name exact", () => {
    const name = "M*ic* _Smith_ :party_parrot:";
    const html = render(`**@${name}**`, {
      participantProfiles: new Map([[mic, { name }]]),
      emoji: [party],
      extensions,
    });
    expect(html).toContain(`aria-label="View ${name} profile"`);
    expect(html).toContain(`</svg>${name}</button></strong>`);
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<img");
  });

  it.each(["Mic `code`", "Mic [link](https://example.test)"])(
    "never lets a matching profile name consume non-prose: %s",
    (name) => {
      const html = render(`@${name}`, {
        participantProfiles: new Map([[mic, { name }]]),
      });
      expect(html).not.toContain("<button");
      expect(html).toMatch(/<code>|<a /);
    },
  );

  it("focuses the clicked mention before opening its exact profile target", () => {
    const calls: string[] = [];
    const canOpenLink = vi.fn((_target: string) => true);
    renderDom(
      <MessageMarkdown
        {...props("**@Mic Smith** then @Mic", {
          canOpenLink,
          onOpenLink: (target) => {
            expect(document.activeElement).toBe(
              target === profileTarget(smith) ? buttons[0] : buttons[1],
            );
            calls.push(target);
            return true;
          },
        })}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const focus = button.focus.bind(button);
      vi.spyOn(button, "focus").mockImplementation(() => {
        calls.push("focus");
        focus();
      });
      fireEvent.click(button);
    }
    expect(calls).toEqual([
      "focus",
      profileTarget(smith),
      "focus",
      profileTarget(mic),
    ]);
    expect(canOpenLink.mock.calls.map(([target]) => target)).toEqual([
      profileTarget(smith),
      profileTarget(mic),
    ]);
  });

  it.each([
    "`https://example.test @Mic`",
    "`` a ` @Mic ``",
    "```ts\n@Mic\n```",
    "~~~\n@Mic\n~~~",
    "`unfinished @Mic",
    "```\n@Mic",
    "    @Mic",
    "\t@Mic",
    "intro\n    @Mic",
    "email@Mic",
    "https://example.test/@Mic",
    "http://example.test/@Mic",
    "[label @Mic](https://example.test)",
    "![alt @Mic](https://example.test)",
    "[@Mic][reference]\n\n[reference]: https://example.test",
    "[@Mic][]\n\n[@Mic]: https://example.test",
    "[@Mic]\n\n[@Mic]: https://example.test",
    "[**@Mic**](https://example.test)",
    "<https://example.test/@Mic>",
    "www.example.test/@Mic",
    "\\@Mic",
    "&#64;Mic",
    "@M&#105;c",
    "@Mic_foo",
    "@Micé",
    `@Mic (${other})`,
  ])(
    "does not create profile controls from excluded raw context: %s",
    (content) => {
      const html = render(content);
      expect(html).not.toContain("<button");
      expect(html).not.toMatch(/[\uE000-\uE002]/);
    },
  );

  it.each([
    "`https://example.test @Mic` then @Mic",
    "    @Mic\n\nOutside @Mic",
    "intro\n    @Mic\nOutside @Mic",
    '```js\nconst marker = "```";\n@Mic\n```\nOutside @Mic',
    "````\n```\n@Mic\n````\nOutside @Mic",
  ])(
    "evaluates full-body exclusions while retaining subsequent prose: %s",
    (content) => {
      const html = render(content);
      expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
      expect(html.lastIndexOf("<button")).toBeGreaterThan(html.indexOf("@Mic"));
    },
  );

  it("does not rebind edited, untagged, unknown, disabled or ambiguous names", () => {
    const unavailable: RenderOptions[] = [
      { patch: { edited: true } },
      { patch: { mentions: [] } },
      { participantProfiles: undefined },
      { canOpenLink: undefined },
      { canOpenLink: () => false },
      {
        patch: { mentions: [mic, other] },
        participantProfiles: new Map([
          [mic, { name: "Mic" }],
          [other, { name: "Mic" }],
        ]),
      },
    ];
    for (const options of unavailable) {
      const html = render("**@Mic**", options);
      expect(html).not.toContain("<button");
      expect(html).toContain("<strong>@Mic</strong>");
    }
    const html = render("@Mic Smith and @Mic", {
      patch: { mentions: [smith, mic, other] },
      participantProfiles: new Map([
        [smith, { name: "Mic Smith" }],
        [mic, { name: "Mic" }],
        [other, { name: "Mic Smith" }],
      ]),
    });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("@Mic Smith and <button");
  });

  it("updates a mounted mention label without changing signed binding or profile target", () => {
    const owned = createRelaySession(null);
    const session = owned.session;
    const listeners = new Set<() => void>();
    let localName = "Local Mic";
    const provider = createAgentDirectory();
    const names = bindNames(
      {
        profiles: session.profiles,
        agentLibrary: {
          snapshot: () => ({
            status: "ready",
            definitions: [],
            identities: [{ id: "mic", pubkey: mic, name: localName }],
          }),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          refresh: async () => {},
          retain: () => () => {},
        },
      },
      { snapshot: () => [provider], subscribe: () => () => {} },
    );
    const open = vi.fn(() => true);
    const mounted = renderDom(
      <MessageMarkdown
        {...props("@Mic and @Local Mic", {
          session: { ...session, names },
          onOpenLink: open,
        })}
      />,
    );
    const button = mounted.getByRole("button", {
      name: "View Local Mic profile",
    });
    expect(mounted.getAllByRole("button")).toHaveLength(1);
    act(() => {
      localName = "Renamed Mic";
      for (const notify of listeners) notify();
    });
    expect(
      mounted.getByRole("button", { name: "View Renamed Mic profile" }),
    ).toBe(button);
    expect(button.textContent).toBe("Renamed Mic");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(profileTarget(mic));
    expect(profiles.get(mic)?.name).toBe("Mic");
    mounted.unmount();
    names.dispose();
    owned.dispose();
  });

  it("cannot fabricate profile controls with literal, entity-encoded or legacy markers", () => {
    const spoof =
      "\uE0000\uE0010\uE002 &#57344;&#49;&#57345;0&#57346; \uE000&#x32;\uE0010\uE002 \uE0000\uE001";
    const html = render(`${spoof} then @Mic`);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(
      "\uE0000\uE0010\uE002 \uE0001\uE0010\uE002 \uE0002\uE0010\uE002 \uE0000\uE001 then <button",
    );
    expect(render(spoof)).not.toContain("<button");
    expect(
      render(
        `<span data-inline-text="@Mic" data-profile-target="${profileTarget(mic)}">spoof</span>`,
      ),
    ).not.toContain("<button");
  });
});

describe("Markdown inline extensions", () => {
  it("preserves custom emoji and plugin prose alongside profile mentions", () => {
    const html = render("**:party_parrot:** PLUGIN @Mic", {
      emoji: [party],
      extensions,
      media: () => "https://media.test/emoji.png",
    });
    expect(html).toContain("<strong><img");
    expect(html).toContain('src="https://media.test/emoji.png"');
    expect(html).toContain('alt=":party_parrot:"');
    expect(html).toContain("<mark>PLUGIN</mark>");
    expect(html).toContain('aria-label="View Mic profile"');
  });

  it("keeps links, code, reference labels and image alt text out of inline plugins", () => {
    const html = render(
      "`:party_parrot: PLUGIN @Mic`\n\n```\n:party_parrot: PLUGIN @Mic\n```\n\n[:party_parrot: PLUGIN @Mic](https://example.test)\n\n[:party_parrot: PLUGIN @Mic]\n\n[:party_parrot: PLUGIN @Mic]: https://example.test/ref\n\n![PLUGIN :party_parrot: @Mic](https://example.test/image)",
      {
        emoji: [party],
        extensions,
        media: () => "https://media.test/emoji.png",
      },
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<mark");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/[\uE000-\uE002]/);
    expect(html).toContain('href="https://example.test/ref"');
    expect(html).toContain(":party_parrot: PLUGIN @Mic</code>");
    expect(html).toContain("PLUGIN :party_parrot: @Mic</span>");
  });

  it("keeps emoji-only sizing and readable fallback when media or extensions are unavailable", () => {
    const options = { emoji: [party], extensions, largeEmoji: true };
    const html = render(":party_parrot:", {
      ...options,
      media: () => "https://media.test/emoji.png",
    });
    expect(html).toContain(
      `class="${styles.text}" data-single-emoji="true"><img`,
    );
    expect(html).not.toContain("<div");
    expect(render(":party_parrot:", options)).toContain(
      'data-single-emoji="true">:party_parrot:</p>',
    );
    expect(
      render(":party_parrot:", { ...options, extensions: undefined }),
    ).toContain('data-single-emoji="true">:party_parrot:</p>');
    expect(render("😀", { largeEmoji: true })).toContain(
      'data-single-emoji="true">😀</p>',
    );
  });
});

it.each([false, true])(
  "retains formatting inside labeled links (plugin enabled: %s)",
  (enabled) => {
    const links = {
      snapshot: () =>
        enabled
          ? [
              {
                id: "link",
                title: "Links",
                key: "links/link",
                pluginId: "links",
                revision: "one",
                matches: () => true,
                component: ({ url }: { url: string }) => (
                  <LinkLabel href={url} />
                ),
              },
            ]
          : [],
      subscribe: () => () => {},
    };
    const html = render(
      "[**Important** or `code`](https://github.com/block/buzz-app)",
      { extensions: { ...extensions, links } },
    );
    expect(html).toContain("<strong>Important</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://github.com/block/buzz-app"');
    expect(html.includes('data-link-kind="github"')).toBe(enabled);
  },
);

it("keeps resolved private channel labels and lock icons for Buzz links", () => {
  const entry = {
    id: "link",
    title: "Links",
    key: "links/link",
    pluginId: "links",
    revision: "one",
    matches: () => true,
    component: ({ url }: { url: string }) => <LinkLabel href={url} />,
  };
  const href = `buzz://message?channel=design&id=${"a".repeat(64)}`;
  const html = render(`<${href}> <buzz://channel/design> #design`, {
    directory: {
      profiles: new Map(),
      agents: [],
      channels: [
        {
          id: "design",
          name: "design",
          channelType: "forum",
          private: true,
        },
      ],
    },
    extensions: {
      ...extensions,
      links: { snapshot: () => [entry], subscribe: () => () => {} },
    },
  });
  expect(html).toContain('data-link-kind="message"');
  expect(html).toContain('data-link-kind="channel"');
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("design");
  expect(text).not.toContain("buzz://");
  const lock = renderToStaticMarkup(
    <LockIcon className={referenceStyles.icon} />,
  );
  expect(html.split(lock)).toHaveLength(3);
});

it("renders tagged agent library names and profile names with the same agent icon", () => {
  const directory = {
    profiles: new Map([[mic, { name: "Fizz" }]]),
    channels: [],
    agents: [{ pubkey: mic, name: "Fast Fizz" }],
  };
  const options = {
    directory,
    participantProfiles: directory.profiles,
    patch: { mentions: [mic] },
  };
  for (const name of ["Fast Fizz", "Fizz"]) {
    const html = render(`@${name} can you also join`, options);
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain(`aria-label="View ${name} profile"`);
    expect(html).toContain(
      renderToStaticMarkup(<RobotIcon className={referenceStyles.icon} />),
    );
  }
  expect(
    render("@Fast Fizz", { ...options, participantProfiles: new Map() }),
  ).toContain('data-mention-kind="agent"');
  for (const patch of [
    { mentions: [] },
    { edited: true as const },
    { attachmentContentRemoved: true as const },
  ])
    expect(
      render("@Fast Fizz", {
        ...options,
        patch: { ...options.patch, ...patch },
      }),
    ).not.toContain("data-mention-kind=");
  expect(render("`@Fast Fizz`", options)).not.toContain("data-mention-kind=");
  expect(
    render("@Fast Fizz", {
      ...options,
      participantProfiles: new Map([[other, { name: "Fast Fizz" }]]),
      patch: { mentions: [mic, other] },
    }),
  ).not.toContain("data-mention-kind=");
});

it("uses the agent icon for a known agent profile outside the local library", () => {
  expect(
    render("@Mic", {
      participantProfiles: new Map([[mic, { name: "Mic", isAgent: true }]]),
    }),
  ).toContain('data-mention-kind="agent"');
});

it("keeps the agent icon without presenting an unavailable profile action", () => {
  const html = render("@Fast Fizz can you also join", {
    directory: {
      profiles: new Map(),
      channels: [],
      agents: [{ pubkey: mic, name: "Fast Fizz" }],
    },
    canOpenLink: undefined,
  });
  expect(html).toContain('data-mention-kind="agent"');
  expect(html).toContain(
    renderToStaticMarkup(<RobotIcon className={referenceStyles.icon} />),
  );
  expect(html).not.toContain("<button");
  expect(html).not.toContain('aria-label="View');
});

it("keeps explicit profile identities visible but inert when Profiles is unavailable", () => {
  const target = profileTarget(mic);
  const view = renderDom(
    <MessageMarkdown
      {...props(`[@Mic](${target})`, {
        patch: { mentions: [] },
        canOpenLink: () => false,
      })}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(view.container.textContent).toContain(target);
  view.rerender(
    <MessageMarkdown
      {...props(`[@Mic](${target})`, {
        patch: { mentions: [] },
        interactive: false,
      })}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(view.container.textContent).toContain("Mic");
});

it.each([
  "nostr:npub1invalid",
  "nostr:nsec1invalid",
  "nostr:note1invalid",
  `buzz:agent-profile:${mic}`,
  `${profileTarget(mic)}?relay=https://example.test`,
  "javascript:alert%281%29",
  "data:text/html,hello",
])(
  "does not open unsupported or malformed identity destinations: %s",
  (target) => {
    const html = render(`[@Mic](${target})`, { patch: { mentions: [] } });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("href=");
    expect(html).toContain("@Mic");
  },
);

it("keeps explicit profile links literal inside code", () => {
  const link = `[@Mic](${profileTarget(mic)})`;
  const html = render(`\`${link}\``, { patch: { mentions: [] } });
  expect(html).not.toContain("<button");
  expect(html).not.toContain("href=");
  expect(html).toContain(link);
});

describe("text spoilers", () => {
  it("hides formatted content and link controls until reveal, and resets after edits", () => {
    const view = renderDom(
      <MessageMarkdown
        {...props("Before ||**secret** [link](https://example.com)|| after")}
      />,
    );
    const reveal = screen.getByRole("button", { name: "Reveal spoiler" });
    const content = view.container.querySelector("[inert]");
    expect(content).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(reveal);
    expect(
      screen.getByRole("button", { name: "Hide spoiler" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector("strong")).toHaveTextContent("secret");
    expect(screen.getByRole("link", { name: "link" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide spoiler" }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal spoiler" }));
    view.rerender(<MessageMarkdown {...props("Before ||changed|| after")} />);
    expect(
      screen.getByRole("button", { name: "Reveal spoiler" }),
    ).toBeInTheDocument();
    expect(view.container.querySelector("[inert]")).toHaveTextContent(
      "changed",
    );
  });

  it.each([
    "`||code||`",
    "```\n||code||\n```",
    "\\|\\|escaped\\|\\|",
    "&#124;&#124;entity&#124;&#124;",
    '<span title="||attribute||">raw</span>',
    "![||alt||](https://image.test/a.png)",
    "[link](https://example.com/||path||)",
    "||unclosed",
    "||||",
    "| a | b |\n| - | - |\n| || | cell |",
  ])("does not turn literal syntax into a reveal control: %s", (content) => {
    expect(render(content)).not.toContain('aria-label="Reveal spoiler"');
  });

  it("keeps spoilers inert in noninteractive previews", () => {
    const html = render("||secret [link](https://example.com)||", {
      interactive: false,
    });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
  });
});

it.each(["one\n\ntwo", "https://example.com/path"])(
  "hides serialized spoiler content before reveal: %s",
  async (text) => {
    const { composerSchema: schema, projectComposerDocument } = await import(
      "./composer-document"
    );
    const { composerMarkdown } = await import("./composer-markdown");
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(
        null,
        schema.text(text, [schema.marks.spoiler.create()]),
      ),
    );
    const wire = composerMarkdown(projectComposerDocument(doc).draft);
    const view = renderDom(<MessageMarkdown {...props(wire)} />);
    expect(
      screen.getAllByRole("button", { name: "Reveal spoiler" }),
    ).toHaveLength(text.includes("\n\n") ? 2 : 1);
    const visibleText = [...view.container.querySelectorAll("p")]
      .map((paragraph) => {
        const clone = paragraph.cloneNode(true) as Element;
        for (const hidden of clone.querySelectorAll('[aria-hidden="true"]'))
          hidden.remove();
        return clone.textContent?.trim();
      })
      .join("");
    expect(visibleText).toBe("");
    for (const button of screen.getAllByRole("button", {
      name: "Reveal spoiler",
    }))
      fireEvent.click(button);
    expect(view.container.textContent).toContain(
      text.includes("\n") ? "one" : text,
    );
    if (!text.includes("\n"))
      expect(screen.getByRole("link")).toHaveAttribute("href", text);
  },
);

it("preserves a GFM table with adjacent pipes and an empty middle cell", () => {
  const html = render("| A || C |\n| - | - | - |\n| a || c |");
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(
    [...container.querySelectorAll("th")].map((cell) => cell.textContent),
  ).toEqual(["A", "", "C"]);
  expect(
    [...container.querySelectorAll("td")].map((cell) => cell.textContent),
  ).toEqual(["a", "", "c"]);
  expect(html).not.toContain("Reveal spoiler");
});

it.each([
  ["**||secret||**", "strong"],
  ["_||secret||_", "em"],
  ["~~||secret||~~", "del"],
])("preserves authored formatting outside a spoiler: %s", (source, tag) => {
  const view = renderDom(<MessageMarkdown {...props(source)} />);
  const formatted = view.container.querySelector(tag);
  expect(formatted).toHaveTextContent("secret");
  expect(formatted?.querySelector("[inert]")).toHaveTextContent("secret");
  expect(view.container.textContent).toBe("secret");
  fireEvent.click(screen.getByRole("button", { name: "Reveal spoiler" }));
  expect(formatted?.querySelector('[aria-hidden="false"]')).toHaveTextContent(
    "secret",
  );
});

it("keeps one channel Larry plain despite global namesakes and follows membership changes", () => {
  const owned = createRelaySession(null);
  const listeners = new Set<() => void>();
  const people = new Map(
    [mic, smith, other].map((key) => [
      key,
      { name: "Larry", isAgent: true as const },
    ]),
  );
  let list = {
    status: "ready" as const,
    channels: [{ id: "channel", name: "Here", members: [mic] }],
  };
  const session = {
    ...owned.session,
    profiles: { ...owned.session.profiles, snapshot: () => people },
    channels: {
      ...owned.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: session.agentLibrary },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const open = vi.fn(() => true);
  const mounted = renderDom(
    <MessageMarkdown
      {...props("@Larry", {
        session: { ...session, names },
        participantProfiles: people,
        patch: { mentions: [mic] },
        onOpenLink: open,
      })}
    />,
  );
  expect(names.resolve(mic)).not.toBe("Larry");
  const button = mounted.getByRole("button", { name: "View Larry profile" });
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith(profileTarget(mic));
  act(() => {
    list = {
      ...list,
      channels: [{ id: "channel", name: "Here", members: [mic, smith] }],
    };
    for (const listener of listeners) listener();
  });
  expect(button.textContent).toMatch(/^Larry · /);
  act(() => {
    list = {
      ...list,
      channels: [{ id: "channel", name: "Here", members: [mic] }],
    };
    for (const listener of listeners) listener();
  });
  expect(button.textContent).toBe("Larry");
  mounted.unmount();
  names.dispose();
  owned.dispose();
});
