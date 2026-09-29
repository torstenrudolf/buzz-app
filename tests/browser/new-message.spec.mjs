import { openPage } from "./navigation.mjs";
import { upper, settle } from "./timeline.mjs";
import { test as base, expect } from "@playwright/test";
import { preview } from "vite";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { relayBrokerPlugin } from "../../dev/relay-broker.mjs";
import { brokerSocket } from "../broker-socket.mjs";
import { fixtureAliases, fixtureRelayUrl } from "../relay-config.ts";
import { buildApp } from "./build.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Actual app, composer, session and broker; only the upstream relay is modeled.
// Ephemeral identities and a network fence prevent any live message or profile write.
const test = base.extend({
  developmentReact: [false, { scope: "worker" }],
  pluginFixtures: [false, { scope: "worker" }],
  compiledApp: [buildApp, { scope: "worker" }],
  app: async ({ compiledApp, page, context }, use) => {
    const key = generateSecretKey(),
      relay = generateSecretKey();
    const viewer = getPublicKey(key),
      author = getPublicKey(relay);
    const sign = (secret, kind, tags, body = "") =>
      finalizeEvent(
        {
          kind,
          tags,
          content: body,
          created_at: Math.floor(Date.now() / 1000),
        },
        secret,
      );
    const secrets = Array.from({ length: 35 }, () => generateSecretKey());
    const people = secrets.map((secret, i) => {
      return sign(
        secret,
        0,
        [],
        JSON.stringify({
          name:
            i === 0
              ? "Avery Chen"
              : i === 1
                ? "Build Agent"
                : `Person ${String(i + 1).padStart(2, "0")}`,
          is_agent: i === 1,
        }),
      );
    });
    const channel = "11111111-1111-4111-8111-111111111111";
    const events = [
      sign(key, 0, [], JSON.stringify({ name: "Browser Fixture" })),
      ...people,
    ];
    const commands = [],
      reads = [];
    let failOpen = false,
      hold = false,
      release = () => {};
    let directoryReady = Promise.resolve(),
      releaseDirectory = () => {};
    let backgroundReady = Promise.resolve(),
      releaseBackground = () => {};
    const publish = async (event) => {
      // Only hold messages: presence/read-state writes must not replace the gate.
      if (hold && event.kind === 9)
        await new Promise((resolve) => {
          release = resolve;
        });
      events.push(event);
      return "saved";
    };
    const socket = brokerSocket(publish);
    const broker = relayBrokerPlugin({
      relayUrl: fixtureRelayUrl,
      communityAliases: fixtureAliases,
      identity: () => key,
      agentLibrary: () => ({ definitions: [], identities: [] }),
      authority: async () => ({ relayAuthor: author }),
      socketFactory: socket.factory,
      upstreamFetch: async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        if (String(url).endsWith("/events")) {
          commands.push(body);
          if (failOpen) {
            failOpen = false;
            return new Response("offline", { status: 503 });
          }
          const members = [
            viewer,
            ...body.tags
              .filter(([tag]) => tag === "p")
              .map(([, pubkey]) => pubkey),
          ];
          events.push(
            sign(
              relay,
              39000,
              [
                ["d", channel],
                ["t", "dm"],
              ],
              JSON.stringify({ name: "Avery Chen", channel_type: "dm" }),
            ),
          );
          events.push(
            sign(relay, 39002, [
              ["d", channel],
              ...members.map((pubkey) => ["p", pubkey]),
            ]),
          );
          return Response.json({
            accepted: true,
            event_id: body.id,
            message: `response:${JSON.stringify({ channel_id: channel })}`,
          });
        }
        if (String(url).endsWith("/query")) {
          reads.push(...body);
          if (body.some((filter) => filter.kinds?.includes(0) && filter.page))
            await directoryReady;
          if (
            body.some(
              (filter) => filter.kinds?.includes(0) && filter.limit === 30,
            )
          )
            await backgroundReady;
          const result = new Map();
          for (const filter of body) {
            let rows = events.filter(
              (event) =>
                (!filter.kinds || filter.kinds.includes(event.kind)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                (!filter.ids || filter.ids.includes(event.id)) &&
                Object.entries(filter).every(
                  ([tag, values]) =>
                    !tag.startsWith("#") ||
                    event.tags.some(
                      ([key, value]) =>
                        key === tag.slice(1) && values.includes(value),
                    ),
                ) &&
                (!filter.search ||
                  JSON.parse(event.content)
                    .name.toLowerCase()
                    .includes(filter.search.toLowerCase())),
            );
            if (filter.page)
              rows = rows.slice(
                (filter.page - 1) * filter.limit,
                filter.page * filter.limit,
              );
            else if (filter.limit) rows = rows.slice(0, filter.limit);
            for (const row of rows) result.set(row.id, row);
            if (filter.top_level) {
              const id = filter["#h"][0];
              const bounds = sign(
                relay,
                39006,
                [
                  ["h", id],
                  ["d", `${id}:head`],
                ],
                JSON.stringify({ has_more: false, next_cursor: null }),
              );
              result.set(bounds.id, bounds);
            }
          }
          return Response.json([...result.values()]);
        }
        return Response.json({});
      },
    });
    const server = await preview({
      ...compiledApp.config,
      plugins: [
        {
          name: "direct-message-fixture",
          configurePreviewServer: (server) => broker.configureServer(server),
        },
      ],
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const errors = watchPageErrors(page);
    await page.addInitScript(
      ({ viewer }) => {
        const key = `buzz-client.v1:${viewer}`;
        if (!localStorage.getItem(key))
          localStorage.setItem(
            key,
            JSON.stringify({
              profile: { name: "Browser Fixture", picture: "" },
              memberships: [{ id: "primary", name: "Primary" }],
              selected: "primary",
            }),
          );
        window.removalSounds = 0;
        HTMLMediaElement.prototype.play = async function () {
          if (this.src.includes("plop.m4a")) window.removalSounds++;
        };
      },
      { viewer },
    );
    try {
      await use({
        origin,
        reads,
        commands,
        publications: socket.publications,
        errors,
        holdPeople: () => {
          directoryReady = new Promise((resolve) => {
            releaseDirectory = resolve;
          });
        },
        showPeople: () => releaseDirectory(),
        // A shared stream where Avery has spoken, so the profile is reachable.
        seedChannel: (id, text) => {
          const avery = getPublicKey(secrets[0]);
          events.push(
            sign(
              relay,
              39000,
              [
                ["d", id],
                ["t", "stream"],
              ],
              JSON.stringify({ name: "general" }),
            ),
            sign(relay, 39002, [
              ["d", id],
              ["p", viewer],
              ["p", avery],
            ]),
            sign(secrets[0], 9, [["h", id]], text),
          );
        },
        holdBackground: () => {
          backgroundReady = new Promise((resolve) => {
            releaseBackground = resolve;
          });
        },
        showBackground: () => releaseBackground(),
        failOpening: () => {
          failOpen = true;
        },
        holdDelivery: () => {
          hold = true;
        },
        publishReadState: () =>
          publish(sign(key, 30078, [["d", "fixture-read-state"]])),
        confirm: () => {
          hold = false;
          release();
        },
      });
    } finally {
      releaseDirectory();
      releaseBackground();
      release();
      server.httpServer.closeAllConnections();
      await new Promise((resolve) => server.httpServer.close(resolve));
    }
  },
});
async function startNewMessage(page) {
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const messages = sidebar.locator('[data-sidebar-section="dms"] summary');
  await messages.hover();
  await sidebar
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(messages.locator("..")).toHaveAttribute("open", "");
}

async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Projects");
  await startNewMessage(page);
}

test("empty compose, keyboard selection, pagination, removal effects, retry, then confirmed normal timeline", async ({
  page,
  app,
}, info) => {
  app.holdPeople();
  app.holdBackground();
  await open(page, app);
  const loading = page.getByRole("status", { name: "Loading people" });
  await expect(loading).toBeVisible();
  await expect(loading.locator('[class*="loadingRow"]')).toHaveCount(10);
  const picker = page.getByRole("listbox", { name: "People" });
  const pickerHeight = await picker.evaluate(
    (element) => element.parentElement.getBoundingClientRect().height,
  );
  const expectStablePicker = () =>
    expect
      .poll(() =>
        picker.evaluate(
          (element) => element.parentElement.getBoundingClientRect().height,
        ),
      )
      .toBe(pickerHeight);
  const shimmer = loading.locator('[class*="loadingAvatar"]').first();
  await expect
    .poll(() =>
      shimmer.evaluate(
        (element) => getComputedStyle(element, "::after").animationName,
      ),
    )
    .toContain("peopleShimmer");
  await page.screenshot({ path: info.outputPath("new-message-loading.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      shimmer.evaluate(
        (element) => getComputedStyle(element, "::after").animationName,
      ),
    )
    .toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  app.showPeople();
  await expect(
    page.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  // Fifteen profiles include the viewer and an uncontrolled agent; thirteen rows paint first.
  await expect(page.getByRole("option")).toHaveCount(13);
  const initialPeople = await page.getByRole("option").allTextContents();
  await expect
    .poll(() =>
      app.reads.some(
        (filter) => filter.kinds?.includes(0) && filter.limit === 30,
      ),
    )
    .toBe(true);
  // Background discovery starts without scrolling and preserves the preview's order.
  app.showBackground();
  await expect(page.getByRole("option")).toHaveCount(34);
  await expect(
    page.getByRole("option", { name: "Build Agent, Agent", exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.getByRole("option").allTextContents()).slice(
      0,
      initialPeople.length,
    ),
  ).toEqual(initialPeople);
  await expect(loading).toHaveCount(0);
  await expectStablePicker();
  const input = page.getByRole("combobox", { name: "Message recipients" });
  await expect(input).toBeFocused();
  // Shared popover portals out of the header and dismisses without stealing focus.
  await expect(
    page.getByRole("group", { name: "Recipients" }).getByRole("listbox"),
  ).toHaveCount(0);
  await page.locator("[data-new-message-body]").click();
  await expect(picker).toHaveCount(0);
  await input.click();
  await expect(picker).toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(picker).toHaveCount(0);
  await page.getByText("To:", { exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-new-message-body]")).toBeEmpty();
  await expect(
    page.getByRole("textbox", {
      name: "New message",
    }),
  ).toHaveAttribute("contenteditable", "false");
  await expect(
    page
      .getByRole("textbox", { name: "New message", exact: true })
      .locator("[data-placeholder]"),
  ).toHaveAttribute("data-placeholder", "");
  for (const name of ["Mention a member", "Insert emoji"]) {
    const tool = page.getByRole("button", { name, exact: true });
    await expect(tool).toBeDisabled();
    await expect(tool).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await expect(page.locator("[data-message-id]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("new-message-empty.png") });
  const loadedPeople = await page.getByRole("option").allTextContents();
  const directoryReads = () =>
    app.reads.filter(
      (filter) => filter.kinds?.includes(0) && filter.page && !filter.search,
    ).length;
  const beforeReopen = directoryReads();
  await openPage(page, "Projects");
  await openPage(page, "Messages");
  await startNewMessage(page);
  await expect(page.getByRole("option")).toHaveCount(34);
  expect(await page.getByRole("option").allTextContents()).toEqual(
    loadedPeople,
  );
  expect(directoryReads()).toBe(beforeReopen);
  await expect(
    page.getByRole("option", { name: "Person 35", exact: true }),
  ).toBeAttached();
  // A partly visible row under the pointer must not snap fully into view.
  const partial = page.getByRole("option", { name: "Person 34", exact: true });
  const scrollTop = await partial.evaluate((row) => {
    const list = row.parentElement;
    list.scrollTop +=
      row.getBoundingClientRect().bottom -
      list.getBoundingClientRect().bottom -
      16;
    return list.scrollTop;
  });
  await partial.dispatchEvent("pointermove", { pointerType: "mouse" });
  await expect(partial).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => picker.evaluate((element) => element.scrollTop))
    .toBe(scrollTop);
  // Keyboard navigation still brings the next row into view without moving focus.
  await input.press("ArrowDown");
  const last = page.getByRole("option", { name: "Person 35", exact: true });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      last.evaluate(
        (row) =>
          row.getBoundingClientRect().bottom <=
          row.parentElement.getBoundingClientRect().bottom + 1,
      ),
    )
    .toBe(true);
  await expect(input).toBeFocused();
  await input.fill("Person 0");
  await expect(page.getByRole("option")).toHaveCount(7);
  await expect
    .poll(() => picker.evaluate((element) => element.clientHeight))
    .toBe(280);
  await expect
    .poll(() => picker.evaluate((element) => element.scrollHeight))
    .toBe(280);
  await page.screenshot({
    path: info.outputPath("new-message-short-results.png"),
  });
  await input.fill("Person");
  await expect(page.getByRole("option")).toHaveCount(33);
  await expectStablePicker();
  await input.fill("Nobody matches this name");
  await expect(
    page.getByText("No matching people.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => picker.evaluate((element) => element.clientHeight))
    .toBeLessThan(100);
  app.holdPeople();
  const searchReads = app.reads.filter((filter) => filter.search).length;
  await input.fill("Avery");
  await expect(loading).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => picker.evaluate((element) => element.clientHeight))
    .toBe(40);
  await page.screenshot({
    path: info.outputPath("new-message-one-result.png"),
  });
  expect(app.reads.filter((filter) => filter.search).length).toBe(searchReads);
  app.showPeople();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "Person 03", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("new-message-recipients.png"),
  });
  // Record the short-lived effect before input. The browser can complete its
  // entire animation while Playwright is waiting for the audio assertion.
  const removal = await page.evaluateHandle(() => {
    const selector = 'img[src$="poof1@3x.png"]';
    const events = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const [nodes, type] of [
          [record.addedNodes, "added"],
          [record.removedNodes, "removed"],
        ]) {
          for (const node of nodes) {
            const image = node.querySelector?.(selector);
            if (image)
              events.push({
                type,
                display:
                  type === "added" ? getComputedStyle(image).display : null,
              });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { events, disconnect: () => observer.disconnect() };
  });
  try {
    await page.getByRole("button", { name: "Remove Person 03" }).click();
    await expect.poll(() => page.evaluate(() => window.removalSounds)).toBe(1);
    // Deliberately inspect creation only after cleanup: slow automation must not
    // miss coverage of either lifecycle boundary.
    await expect
      .poll(() =>
        removal.evaluate(({ events }) => events.map(({ type }) => type)),
      )
      .toEqual(["added", "removed"]);
    expect(await removal.evaluate(({ events }) => events[0].display)).not.toBe(
      "none",
    );
    await expect(page.locator('img[src$="poof1@3x.png"]')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await input.press("Backspace");
    await expect.poll(() => page.evaluate(() => window.removalSounds)).toBe(2);
    await expect
      .poll(() =>
        removal.evaluate(({ events }) => events.map(({ type }) => type)),
      )
      .toEqual(["added", "removed", "added", "removed"]);
    expect(await removal.evaluate(({ events }) => events[2].display)).toBe(
      "none",
    );
    await expect(page.locator('img[src$="poof1@3x.png"]')).toHaveCount(0);
  } finally {
    await removal.evaluate((observer) => observer.disconnect());
    await removal.dispose();
  }
  await page.getByRole("option", { name: "Avery Chen", exact: true }).click();
  const composer = page.getByRole("textbox", {
    name: "Message Avery Chen",
    exact: true,
  });
  // Both real extension paths use the selected roster before any DM exists.
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  const mentions = page.getByRole("dialog", {
    name: "Mention a member or agent",
  });
  const averyMention = mentions.getByRole("button", { name: /^Avery Chen / });
  await expect(mentions.getByRole("button")).toHaveCount(1);
  await averyMention.click();
  await expect(composer).toHaveText("@Avery Chen ");
  // Clear the rich token through the editor's keyboard selection command, not
  // fill()'s synthetic DOM range, before exercising the completion path.
  await composer.press("ControlOrMeta+a");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");
  await composer.pressSequentially("@Av");
  const suggestions = page.getByRole("listbox", {
    name: "Mention suggestions",
  });
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(
    suggestions.getByRole("option", { name: /^Avery Chen / }),
  ).toBeVisible();
  expect(app.commands).toHaveLength(0);
  await composer.press("Enter");
  await composer.pressSequentially("Our first direct message");
  app.failOpening();
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).not.toBeFocused();
  await expect(picker).not.toBeVisible();
  await expect(composer).toHaveText("@Avery Chen Our first direct message");
  await expect(
    page.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeVisible();
  app.holdDelivery();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(1);
  await expect(input).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  const sidebarDm = page
    .getByRole("complementary", { name: "Channel sidebar" })
    .getByRole("button", { name: "Avery Chen", exact: true });
  await expect(sidebarDm).toHaveCount(0);
  const firstSend = app.publications.find((event) => event.kind === 9);
  expect(firstSend.tags.filter(([name]) => name === "p")).toEqual(
    app.commands[0].tags.filter(([name]) => name === "p"),
  );
  app.confirm();
  await expect(sidebarDm).toBeVisible();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toHaveCount(0);
  const message = page.locator("[data-message-id]", {
    hasText: "Our first direct message",
  });
  await expect(message).toHaveCount(1);
  await expect(message).toBeVisible();
  await expect(message.locator("time")).toBeVisible();
  const visibleDate = await message.locator("time").evaluate((time) =>
    new Date(time.dateTime).toLocaleDateString(undefined, {
      year: "numeric",
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );
  await expect(message.getByText(visibleDate, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Avery Chen" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("new-message-delivered.png") });
  // Give this DM a real above-bottom reading position. A short timeline masks
  // a lost setSent -> select handoff when New message resolves the selected DM.
  const dmInput = page.getByRole("textbox", { name: "Message #Avery Chen" });
  await dmInput.fill(
    Array.from({ length: 60 }, (_, i) => `Reading paragraph ${i + 1}`).join(
      "\n\n",
    ),
  );
  await dmInput.press("Enter");
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(2);
  await expect(dmInput).toHaveJSProperty("value", "");
  // A full reload exercises IndexedDB acknowledgement: the recovery association
  // must be gone before another New message starts.
  await page.reload();
  await expect(dmInput).toBeVisible();
  await upper(page);
  await expect(sidebarDm).toHaveAttribute("aria-current", "page");
  // Resolving an existing DM keeps its row visible while the next send is held.
  await startNewMessage(page);
  await page.getByRole("option", { name: "Avery Chen", exact: true }).click();
  // Composing is a separate route, not the previously selected conversation.
  await expect(sidebarDm).toBeVisible();
  await expect(sidebarDm).not.toHaveAttribute("aria-current", "page");
  await page
    .getByRole("textbox", { name: "Message Avery Chen", exact: true })
    .fill("Another message");
  app.holdDelivery();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(3);
  await expect(sidebarDm).toBeVisible();
  // A concurrent non-message write must not replace the held message's gate.
  await app.publishReadState();
  app.confirm();
  await expect(
    page.locator("[data-message-id]", { hasText: "Another message" }),
  ).toBeInViewport();
  await settle(page);
  await expect
    .poll(() =>
      page
        .getByRole("region", { name: "Channel message history" })
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(4);
  await expect(sidebarDm).toHaveAttribute("aria-current", "page");
  expect(app.errors.unexplained()).toEqual([]);
});

test("profile Message opens a fresh DM and restores a hidden one", async ({
  page,
  app,
}) => {
  app.seedChannel("22222222-2222-4222-8222-222222222222", "Hello from Avery");
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("complementary", { name: "Channel sidebar" });
  const general = sidebar.locator(
    '[data-channel-id="22222222-2222-4222-8222-222222222222"]',
  );
  const sidebarDm = sidebar.getByRole("button", {
    name: "Avery Chen",
    exact: true,
  });
  const openProfileMessage = async () => {
    await general.click();
    await page
      .locator("[data-message-id]", { hasText: "Hello from Avery" })
      .getByRole("button", { name: "View Avery Chen profile" })
      .click();
    const profile = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    await profile.getByRole("button", { name: "Message", exact: true }).click();
  };
  await expect(sidebarDm).toHaveCount(0);
  await openProfileMessage();
  await expect(sidebarDm).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Avery Chen" }),
  ).toBeVisible();
  expect(app.commands).toHaveLength(1);
  expect(app.commands[0].kind).toBe(41010);
  // A locally hidden DM reappears when the profile opens it again.
  await sidebarDm.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions for Avery Chen" })
    .getByRole("menuitem", { name: "Remove from Messages", exact: true })
    .click();
  await expect(sidebarDm).toHaveCount(0);
  await page.reload();
  await expect(sidebarDm).toHaveCount(0);
  await openProfileMessage();
  await expect(sidebarDm).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Avery Chen" }),
  ).toBeVisible();
  await page.reload();
  await expect(sidebarDm).toBeVisible();
  expect(app.commands).toHaveLength(2);
  expect(app.errors.unexplained()).toEqual([]);
});
