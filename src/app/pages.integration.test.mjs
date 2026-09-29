import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("the app runtime exposes ready bundled pages and removes them on disable", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false },
  });
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  let services;
  try {
    const { createServices } = await vite.ssrLoadModule("/src/app/services.ts");
    services = createServices();
    assert.deepEqual(services.pages.snapshot(), []);
    await vi.waitFor(() =>
      assert.equal(
        services.accountActions.snapshot()[0]?.key,
        "buzz.feedback/send",
      ),
    );
    const firstFeedback = services.accountActions.snapshot()[0];
    await services.plugins.change("disable", "buzz.feedback");
    assert.deepEqual(services.accountActions.snapshot(), []);
    await services.plugins.change("enable", "buzz.feedback");
    await vi.waitFor(() =>
      assert.equal(
        services.accountActions.snapshot()[0]?.key,
        "buzz.feedback/send",
      ),
    );
    assert.notEqual(services.accountActions.snapshot()[0], firstFeedback);
    await settle();
    assert.equal(services.pages.snapshot().length, 7);
    const inbox = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.inbox");
    assert.equal(inbox.title, "Inbox");
    assert.equal(inbox.layout, "workspace");
    assert.equal(inbox.primary, true);
    assert.match(
      renderToStaticMarkup(createElement(inbox.component)),
      /Content coming soon/,
    );
    assert.deepEqual(services.channelTemplates.snapshot(), []);
    assert.deepEqual(
      services.settingsCards.snapshot().map((card) => card.pluginId),
      ["buzz.channels", "block.hosted-communities", "buzz.emoji"],
    );
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.todos"),
      false,
    );
    const canvas = services.relay.snapshot().session.canvas;
    await services.plugins.change("enable", "buzz.todos");
    await vi.waitFor(() =>
      assert.ok(
        services.panels.snapshot().find((p) => p.pluginId === "buzz.todos")
          ?.channelLauncher,
      ),
    );
    const firstTodos = services.panels
      .snapshot()
      .find((p) => p.pluginId === "buzz.todos");
    await services.plugins.change("disable", "buzz.todos");
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.todos"),
      false,
    );
    assert.equal(services.relay.snapshot().session.canvas, canvas);
    await services.plugins.change("enable", "buzz.todos");
    await vi.waitFor(() =>
      assert.ok(
        services.panels.snapshot().find((p) => p.pluginId === "buzz.todos"),
      ),
    );
    assert.notEqual(
      services.panels.snapshot().find((p) => p.pluginId === "buzz.todos"),
      firstTodos,
    );
    await services.plugins.change("disable", "buzz.todos");
    await services.plugins.change("enable", "buzz.channel-templates");
    await vi.waitFor(() =>
      assert.equal(services.channelTemplates.snapshot().length, 1),
    );
    const originalTemplates = services.channelTemplates.snapshot()[0];
    assert.ok(
      services.settingsCards
        .snapshot()
        .some((card) => card.pluginId === "buzz.channel-templates"),
    );
    await services.plugins.change("disable", "buzz.channel-templates");
    assert.deepEqual(services.channelTemplates.snapshot(), []);
    assert.deepEqual(
      services.settingsCards.snapshot().map((card) => card.pluginId),
      ["buzz.channels", "block.hosted-communities", "buzz.emoji"],
    );
    await services.plugins.change("enable", "buzz.channel-templates");
    await vi.waitFor(() =>
      assert.equal(services.channelTemplates.snapshot().length, 1),
    );
    assert.notEqual(services.channelTemplates.snapshot()[0], originalTemplates);
    await services.plugins.change("disable", "buzz.channel-templates");

    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 2),
    );
    assert.equal(services.conversation.inline.snapshot().length, 1);
    await vi.waitFor(() =>
      assert.equal(services.conversation.links.snapshot().length, 1),
    );
    assert.equal(
      services.conversation.links.snapshot()[0].pluginId,
      "buzz.links",
    );
    await services.plugins.change("disable", "buzz.links");
    assert.equal(services.conversation.links.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.links");
    await vi.waitFor(() =>
      assert.equal(services.conversation.links.snapshot().length, 1),
    );
    await services.plugins.change("disable", "buzz.emoji");
    assert.deepEqual(
      services.conversation.tools.snapshot().map((tool) => tool.pluginId),
      ["buzz.mentions"],
    );
    assert.equal(services.conversation.inline.snapshot().length, 0);
    await services.plugins.change("disable", "buzz.mentions");
    assert.equal(services.conversation.tools.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.mentions");
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 1),
    );
    await services.plugins.change("enable", "buzz.emoji");
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 2),
    );

    const { npubEncode } = await import("nostr-tools/nip19");
    const profileTarget = `nostr:${npubEncode("ab".repeat(32))}`;
    assert.equal(
      services.panels.resolve(profileTarget)?.pluginId,
      "buzz.profiles",
    );
    await services.plugins.change("disable", "buzz.profiles");
    assert.equal(services.panels.resolve(profileTarget), undefined);
    await services.plugins.change("enable", "buzz.profiles");
    await vi.waitFor(() =>
      assert.equal(
        services.panels.resolve(profileTarget)?.pluginId,
        "buzz.profiles",
      ),
    );

    const activity = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.agent-activity");
    assert.equal(activity.title, "Agent Activity");
    assert.equal(activity.launcher, undefined);
    assert.equal(services.conversation.accessories.snapshot().length, 1);
    assert.equal(
      services.conversation.accessories.snapshot()[0].pluginId,
      "buzz.agent-activity",
    );
    assert.match(
      renderToStaticMarkup(createElement(activity.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.agent-activity");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.agent-activity"),
      false,
    );
    assert.equal(services.conversation.accessories.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.agent-activity");
    await vi.waitFor(() =>
      assert.ok(
        services.panels
          .snapshot()
          .some((panel) => panel.pluginId === "buzz.agent-activity"),
      ),
    );

    const firstBestie = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.bestie");
    assert.equal(firstBestie.title, "Bestie");
    assert.equal(firstBestie.launcher.icon, "/bestie.png");
    assert.match(
      renderToStaticMarkup(
        createElement(firstBestie.component, { target: "", close() {} }),
      ),
      /isn’t connected yet/,
    );
    const bestiePage = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.bestie");
    assert.equal(bestiePage.title, "Bestie");
    assert.equal(bestiePage.layout, "workspace");
    assert.equal(bestiePage.primary, true);
    assert.match(
      renderToStaticMarkup(createElement(bestiePage.component)),
      /isn’t connected yet/,
    );
    await services.plugins.change("disable", "buzz.bestie");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(
      services.pages.snapshot().some((page) => page.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(services.pages.snapshot().length, 6);
    await services.plugins.change("enable", "buzz.bestie");
    // Management completion is not activation completion; Cordis still owns import/disposal barriers.
    await vi.waitFor(() =>
      assert.ok(
        services.panels
          .snapshot()
          .some((panel) => panel.pluginId === "buzz.bestie"),
      ),
    );
    const secondBestie = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.bestie");
    assert.notEqual(secondBestie, firstBestie);
    assert.equal(secondBestie.revision, firstBestie.revision);
    const page = services.pages.snapshot()[0];
    assert.match(
      renderToStaticMarkup(createElement(page.component)),
      /Your channels, one conversation/,
    );
    const agents = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.agents");
    assert.equal(agents.title, "Agents");
    assert.match(
      renderToStaticMarkup(createElement(agents.component)),
      /Connect to a community/,
    );
    const agentMarkup = renderToStaticMarkup(createElement(agents.component));
    assert.match(agentMarkup, /Local agent controls/);
    assert.match(agentMarkup, /Local agent controls require the desktop app/);
    const localControl = services.agentControl;
    const session = services.relay.snapshot().session;
    const sessionsPage = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.sessions");
    assert.equal(sessionsPage.title, "Sessions");
    assert.match(
      renderToStaticMarkup(createElement(sessionsPage.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.sessions");
    assert.equal(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.sessions"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    const nameFacts = [
      { pubkey: "a".repeat(64), name: "Alex" },
      { pubkey: "b".repeat(64), name: "Alex" },
    ];
    const named = () =>
      session.names.resolve(
        nameFacts[0].pubkey,
        "Unknown",
        nameFacts.map((row) => row.pubkey),
        nameFacts,
      );
    const qualified = named();
    assert.match(qualified, /^Alex · /);
    await services.plugins.change("disable", "buzz.agents");
    assert.equal(
      services.pages.snapshot().some((page) => page.pluginId === "buzz.agents"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    assert.equal(named(), qualified, "Agents does not own naming policy");
    await services.plugins.change("disable", "buzz.identity-naming");
    assert.equal(named(), "Unknown");
    await services.plugins.change("enable", "buzz.identity-naming");
    await vi.waitFor(() => assert.equal(named(), qualified));
    assert.equal(services.agentControl, localControl);
    await services.plugins.change("enable", "buzz.agents");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.agents"),
      ),
    );
    assert.equal(services.agentControl, localControl);
    await services.plugins.change("disable", "buzz.agents");
    assert.ok(session.agentLibrary);
    const workflows = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.workflows");
    assert.equal(workflows.title, "Workflows");
    assert.equal(workflows.layout, "workspace");
    assert.match(
      renderToStaticMarkup(createElement(workflows.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.workflows");
    assert.equal(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.workflows"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    assert.ok(session.workflows);
    await services.plugins.change("enable", "buzz.workflows");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.workflows"),
      ),
    );
    await services.plugins.change("disable", "buzz.workflows");
    assert.equal(
      await services.plugins.change("disable", "buzz.channels"),
      false,
    );
    const projects = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.projects");
    assert.equal(services.pages.snapshot().length, 4);
    assert.equal(projects.pluginId, "buzz.projects");
    assert.equal(projects.id, "projects");
    assert.equal(projects.title, "Projects");
    assert.equal(projects.layout, "workspace");
    assert.equal(projects.handlesNavigation, true);
    assert.equal(projects.primary, true);
    assert.equal(projects.route.version, 1);
    assert.equal(
      projects.route.validate({
        type: "repo",
        owner: "a".repeat(64),
        dtag: "repo",
      }),
      true,
    );
    assert.equal(
      projects.route.validate({
        type: "repo",
        owner: "a".repeat(64),
        dtag: "repo",
        arbitrary: true,
      }),
      false,
    );
    assert.match(
      renderToStaticMarkup(createElement(projects.component)),
      /Select a community to browse projects/,
    );
    await services.plugins.change("disable", "buzz.projects");
    // Bestie was re-enabled above, so it registered after Inbox.
    assert.deepEqual(
      services.pages.snapshot().map((page) => page.pluginId),
      ["buzz.channels", "buzz.inbox", "buzz.bestie"],
    );
    await services.plugins.change("enable", "buzz.projects");
    await vi.waitFor(() => {
      const restored = services.pages
        .snapshot()
        .find((page) => page.pluginId === "buzz.projects");
      assert.equal(restored?.pluginId, "buzz.projects");
      assert.notEqual(restored, projects);
    });
  } finally {
    await services?.dispose();
    await vite.close();
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  }
  // A real Vite server, the whole service graph and every page render take
  // seconds alone, so the default budget expires under a parallel suite.
}, 30_000);
