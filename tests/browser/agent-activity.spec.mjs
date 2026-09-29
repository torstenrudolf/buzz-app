import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({
  productionBroker: true,
  // Navigation can publish read positions through the real broker.
  readState: true,
  developmentReact: true,
});

const channelActivity = (page) =>
  page.getByRole("region", {
    name: "Agent activity in this channel",
    exact: true,
  });
const agentEntry = (page, agent) =>
  channelActivity(page).getByRole("button", {
    name: new RegExp(
      `^View activity for .+ ${agent.slice(0, 12)}(?:, Presence: (?:online|away|offline))?$`,
    ),
  });
const activityPanel = (page) =>
  page.getByRole("region", { name: "Agent activity", exact: true });
const activity = (kind, channelId, turnId, payload) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId,
  sessionId: "S",
  turnId,
  ...(payload === undefined ? {} : { payload }),
});

test("mention picker demands the relay's protected archive snapshot", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Mention a member or agent" }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        app.report.queries.filter(({ filter }) => filter.kinds?.includes(13535))
          .length,
    )
    .toBeGreaterThan(0);
  expect(
    app.report.queries
      .filter(({ filter }) => filter.kinds?.includes(13535))
      .every(
        ({ filter }) =>
          filter.authors?.length === 1 &&
          filter.limit === 1 &&
          Object.keys(filter).length === 3,
      ),
  ).toBe(true);
});

// The composer entry is the only channel launcher. Profile activity remains the
// durable fallback after fresh working evidence disappears (covered below).
test("channel activity consumes telemetry, isolates mixed batches, selects agents, and resets on disable", async ({
  page,
  app,
}) => {
  // Hold the first explicit profile read before broker admission so telemetry
  // demand cannot coalesce into it; hold all upstream presence responses too,
  // including a replacement if that first request is cancelled.
  app.relay.holdPresence();
  const firstSnapshot = Promise.withResolvers();
  let firstAuthors;
  await page.route("**/presence-snapshot", async (route) => {
    if (!firstAuthors) {
      firstAuthors = route.request().postDataJSON()[0].authors;
      await firstSnapshot.promise;
    }
    await route.fallback();
  });
  const firstKey = generateSecretKey();
  const secondKey = generateSecretKey();
  const first = getPublicKey(firstKey);
  const second = getPublicKey(secondKey);
  const region = channelActivity(page);
  const firstEntry = agentEntry(page, first);
  const secondEntry = agentEntry(page, second);
  let unsafe;
  try {
    await open(page, app);
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    await expect.poll(() => firstAuthors).toBeDefined();
    await expect(
      page.getByRole("button", { name: "Agent Activity", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    unsafe = app.observer(
      activity("turn_liveness", "alpha", "one", {
        text: '<img src=x onerror="window.telemetryExecuted=true">',
      }),
      firstKey,
    );
    app.observer(activity("turn_liveness", "alpha", "two"), secondKey);
    app.observer(
      {
        kind: "batch",
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        payload: {
          events: [
            activity("acp_read", "alpha", "one", "wanted child"),
            activity("acp_write", "beta", "other-channel", "other channel"),
          ],
        },
      },
      firstKey,
    );

    await expect(region).toBeVisible();
    await expect(firstEntry).toBeVisible();
    expect(firstAuthors).not.toContain(first);
    expect(firstAuthors).not.toContain(second);
    // Neither agent publishes live presence in this fixture. Even if demand
    // cancels and retries the held snapshot, neither response can label it yet.
    await expect(firstEntry).not.toHaveAccessibleName(/, Presence:/);
  } finally {
    firstSnapshot.resolve();
    app.relay.releasePresence();
  }
  await expect
    .poll(() =>
      app.report.presenceSnapshots.some(
        ({ filter, pending, aborted }) =>
          filter.authors.includes(first) && !pending && !aborted,
      ),
    )
    .toBe(true);
  await expect(firstEntry).toHaveAccessibleName(/, Presence: online$/);
  await page.getByRole("button", { name: "Close channel panel" }).click();
  // A busy skip followed by a successful retry must not masquerade as recovery.
  expect(
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/presence-snapshot"),
    ),
  ).toHaveLength(app.report.presenceSnapshots.length);
  await expect(firstEntry).toContainText("working");
  await expect(secondEntry).toBeVisible();
  await expect(region).toHaveCSS("border-top-width", "0px");
  await expect(region).toHaveCSS("border-right-width", "0px");
  await expect(region).toHaveCSS("border-bottom-width", "0px");
  await expect(region).toHaveCSS("border-left-width", "0px");
  const workingIndicator = firstEntry.locator("svg[data-working]");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(workingIndicator).not.toHaveCSS("animation-name", "none");
  await expect(workingIndicator).toHaveCSS("animation-duration", "1.4s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(workingIndicator).toHaveCSS("animation-name", "none");
  await expect(firstEntry).toContainText("working");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await firstEntry.hover();
  const tooltip = page.getByRole("tooltip").filter({ hasText: first });
  await expect(tooltip).toContainText(
    "1 working turn(s) in this channel, including threads.",
  );
  await expect(tooltip).toContainText(
    "Owner-only activity. Select to inspect.",
  );
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  // Establish a starting point, then leave and re-enter using actual keyboard
  // input. focus() alone neither clears Escape dismissal nor proves :focus-visible.
  await firstEntry.focus();
  await page.keyboard.press("Tab");
  await expect(firstEntry).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(firstEntry).toBeFocused();
  await expect(tooltip).toContainText(first);
  await expect(firstEntry).toHaveAccessibleDescription(/Owner-only activity/);
  await firstEntry.press("Enter");

  const panel = activityPanel(page);
  await expect(panel.locator("code").first()).toHaveText(first);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(/Alpha.*alpha/);
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  // Telemetry supplies keys before any profile or directory facts exist.
  const agentSelect = panel.getByRole("combobox", {
    name: "Agent",
    exact: true,
  });
  for (const key of [second, first]) {
    await agentSelect.click();
    const choices = page.getByRole("option");
    await expect(choices).toHaveCount(2);
    const labels = await choices.allTextContents();
    expect(new Set(labels).size).toBe(2);
    const label = labels.find(
      (text) =>
        text.startsWith("Agent · npub…") &&
        npubEncode(key).endsWith(text.slice("Agent · npub…".length)),
    );
    expect(label).toBeDefined();
    const choice = page.getByRole("option", { name: label, exact: true });
    await expect(choice).toBeVisible();
    await choice.click();
    await expect(panel.locator("code").first()).toHaveText(key);
  }
  const unsafeDisclosure = panel.getByRole("button", { name: /turn_liveness/ });
  await unsafeDisclosure.focus();
  await unsafeDisclosure.press("Enter");
  await expect(panel.locator("pre code")).toHaveText(unsafe.plaintext);
  expect(await page.evaluate(() => window.telemetryExecuted)).toBeUndefined();
  await unsafeDisclosure.press("Space");
  await expect(panel.locator("pre code")).not.toBeVisible();

  const matchingChild = panel.getByRole("button", { name: /acp_read/ });
  await expect(matchingChild).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toHaveCount(0);
  await matchingChild.click();
  await expect(panel.locator("pre code")).toContainText('"channelId": "alpha"');
  await expect(panel.locator("pre code")).not.toContainText("other channel");

  await page.getByRole("button", { name: "Close channel panel" }).click();
  await expect(firstEntry).toBeFocused();
  await secondEntry.click();
  await expect(panel.locator("code").first()).toHaveText(second);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close channel panel" }).click();
  await expect(secondEntry).toBeFocused();
  await secondEntry.click();
  await expect(panel.locator("code").first()).toHaveText(second);

  const sockets = app.relay.sockets.length;
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Enable Agent Activity",
    exact: true,
  });
  await toggle.click();
  await expect
    .poll(() => app.relay.hasRoute("primary", "observer"))
    .toBe(false);
  expect(app.relay.sockets).toHaveLength(sockets);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(region).toHaveCount(0);

  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await toggle.click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.observer(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(agentEntry(page, first)).toBeVisible();
  await expect(agentEntry(page, second)).toHaveCount(0);
  await agentEntry(page, first).click();
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);

  // Stale evidence is unknown, not completed; one terminal turn must not hide
  // another active turn for the same agent. Capture survives closing the panel.
  await page.getByRole("button", { name: "Close channel panel" }).click();
  app.observer(activity("turn_completed", "alpha", "after-reset"), firstKey);
  await expect(agentEntry(page, first)).toHaveCount(0);
  app.observer(
    {
      ...activity("turn_liveness", "alpha", "stale"),
      timestamp: new Date(Date.now() - 31_000).toISOString(),
    },
    firstKey,
  );
  await expect(agentEntry(page, first)).toContainText("status unknown");
  await expect(
    agentEntry(page, first).locator(".navigation-item-trailing svg"),
  ).toHaveCSS("animation-name", "none");
  app.observer(activity("turn_liveness", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("working");
  app.observer(activity("turn_completed", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("status unknown");
  app.observer(activity("turn_completed", "alpha", "stale"), firstKey);
  await expect(region).toHaveCount(0);
});

for (const mode of ["light", "dark"]) {
  test(`channel activity entry and raw disclosure fit wide and narrow layouts in ${mode}`, async ({
    page,
    app,
  }, testInfo) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const agentKey = generateSecretKey();
    const agent = getPublicKey(agentKey);
    const secondKey = generateSecretKey();
    app.observer(
      activity("turn_liveness", "alpha", "second-layout"),
      secondKey,
    );
    app.observer(
      activity("acp_read", "alpha", "layout", {
        text: "A long literal raw record. ".repeat(40),
      }),
      agentKey,
    );
    const entry = agentEntry(page, agent);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(entry).toBeVisible();
      const entryBox = await entry.boundingBox();
      const formBox = await page
        .getByRole("form", { name: "Send a message to Alpha", exact: true })
        .boundingBox();
      expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(formBox.y);
      const avatar = entry.locator(".buzz-avatar");
      // Production CSS must retain a loadable SVG mask after bundling. A valid
      // mask-image string alone can still point to the HTML fallback route.
      await expect
        .poll(() =>
          avatar.evaluate(async (element) => {
            const mask = getComputedStyle(element).maskImage;
            const image = new Image();
            image.src = mask.slice(4, -1).replace(/^["']|["']$/g, "");
            try {
              await image.decode();
              return image.naturalWidth > 0;
            } catch {
              return false;
            }
          }),
        )
        .toBe(true);
      const avatarBox = await avatar.boundingBox();
      // Shared navigation owns its inset; the row still aligns with the composer.
      const inset = await entry.evaluate((element) =>
        parseFloat(getComputedStyle(element).paddingLeft),
      );
      expect(entryBox.x).toBeCloseTo(formBox.x, 0);
      expect(avatarBox.x).toBeCloseTo(formBox.x + inset, 0);
      const lastRow = await channelActivity(page)
        .getByRole("button")
        .last()
        .boundingBox();
      expect(formBox.y - lastRow.y - lastRow.height).toBeCloseTo(4, 0);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      // Escape suppresses hover until the pointer leaves the trigger. A viewport
      // resize can keep WebKit's pointer over it, so make the next entry explicit.
      await page.mouse.move(0, 0);
      await entry.hover();
      await expect(page.getByRole("tooltip")).toContainText(
        "in this channel, including threads.",
      );
      await page.screenshot({
        path: testInfo.outputPath(`activity-entry-${mode}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      // Escape starts Base UI's asynchronous unmount. The closing portal still
      // has its wide-screen position and can overflow the next narrow viewport.
      await expect(
        page.getByRole("tooltip", { includeHidden: true }),
      ).toHaveCount(0);
    }

    await entry.click();
    const panel = activityPanel(page);
    await panel.getByRole("button", { name: /acp_read/ }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.locator("pre code")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${mode}-${width}.png`),
      });
    }
  });
}

const profileChannelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const it = test.extend({
  readState: true,
  channelIds: [profileChannelId, "beta"],
  channelNames: { [profileChannelId]: "Alpha" },
  historyCounts: { [profileChannelId]: 1, beta: 1 },
});
it("profile activity opens the exact agent and originating channel before its first frame", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  // The production broker advertises read-state writes even without the
  // readState fixture option. Exercise that publication before profile activity.
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Edit channel details", exact: true })
      .getByText(
        "Only current channel owners and admins can edit these details.",
      ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Leave channel", exact: true }),
  ).toBeVisible();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect.poll(() => app.report.readPublications.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  // A person's profile carries no activity card: neither preview nor launcher.
  const personKey = generateSecretKey();
  const personMessage = finalizeEvent(
    {
      kind: 9,
      tags: [["h", profileChannelId]],
      content: "Contextual person entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    personKey,
  );
  app.relay.publish("primary", personMessage);
  await page
    .locator(`[data-message-id="${personMessage.id}"]`)
    .getByRole("button", { name: /profile/ })
    .click();
  // The settled metadata read is the barrier: no agent evidence can follow it.
  await expect(
    profile.getByText("No profile metadata is available in this community."),
  ).toBeVisible();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toHaveCount(0);
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  const agentKey = generateSecretKey();
  const agent = getPublicKey(agentKey);
  app.serveProfile(agentKey, { name: "Fixture agent", is_agent: true });
  const message = finalizeEvent(
    {
      kind: 9,
      tags: [["h", profileChannelId]],
      content: "Contextual agent entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    agentKey,
  );
  app.relay.publish("primary", message);
  const avatar = page
    .locator(`[data-message-id="${message.id}"]`)
    .getByRole("button", { name: /profile/ });
  await avatar.waitFor();
  // Reading the live message can outlast the normal publication debounce while
  // the profile is open. Exercise that boundary instead of racing teardown.
  await page
    .getByRole("region", { name: "Channel message history", exact: true })
    .focus();
  await expect
    .poll(() =>
      app.report.readPublications.some(
        ({ community, blob }) =>
          community === "primary" &&
          blob.contexts[`msg:${message.id}`] === message.created_at,
      ),
    )
    .toBe(true);
  await avatar.click();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toContainText("No activity yet");
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.locator("code").first()).toHaveText(agent);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(`Alpha · ${profileChannelId}`);
  await expect(
    panel.getByText(
      /Waiting for live records for this identity in this channel/,
    ),
  ).toBeVisible();
  const item = (kind, channelId, turnId) => ({
    kind,
    channelId,
    turnId,
    sessionId: null,
    timestamp: new Date().toISOString(),
  });
  app.observer(
    item("acp_read", profileChannelId, "other-agent"),
    generateSecretKey(),
  );
  app.observer(item("acp_write", "beta", "other-channel"), agentKey);
  app.observer(item("session_resolved", null, "unscoped"), agentKey);
  const expected = app.observer(
    item("turn_liveness", profileChannelId, "wanted"),
    agentKey,
  );
  const row = panel.getByRole("button", { name: /turn_liveness/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  await expect(
    panel.getByRole("button", {
      name: /acp_read|acp_write|session_resolved/,
    }),
  ).toHaveCount(0);
  await row.click();
  await expect(panel.locator("pre code")).toHaveText(expected.plaintext);
  await panel.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", {
      name: "All channels (including unscoped records)",
      exact: true,
    })
    .click();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /session_resolved/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await panel.press("Escape");
  await expect(avatar).toBeFocused();
  await avatar.click();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }).locator("time"),
  ).toHaveAttribute("datetime", JSON.parse(expected.plaintext).timestamp);
  const preview = profile.getByRole("region", { name: "Activity preview" });
  await profile.getByRole("tab", { name: "Channels", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    JSON.parse(expected.plaintext).timestamp,
  );
  const update = (value) => ({
    ...item("acp_read", profileChannelId, "wanted"),
    payload: { method: "session/update", params: { update: value } },
  });
  app.observer(
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: {
        type: "text",
        text: "I found the issue in the channel subscription. ",
      },
    }),
    agentKey,
  );
  app.observer(
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: {
        type: "text",
        text: "Checking the fix against the existing tests.",
      },
    }),
    agentKey,
  );
  app.observer(
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tests",
      title: "Run profile tests",
      status: "in_progress",
    }),
    agentKey,
  );
  await expect(
    preview.getByRole("list", { name: "Recent activity" }),
  ).toContainText(
    "I found the issue in the channel subscription. Checking the fix against the existing tests.",
  );
  await expect(
    preview.getByText("Run profile tests", { exact: true }),
  ).toBeVisible();
  app.observer(
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tests",
      status: "completed",
    }),
    agentKey,
  );
  await expect(
    preview.getByText("Tool completed", { exact: true }),
  ).toBeVisible();
  await profile.getByRole("tab", { name: "Channels", exact: true }).click();
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(
    preview.getByText("Run profile tests", { exact: true }),
  ).toBeVisible();
  // Exercise painted theme/layout, not the separate appearance persistence contract.
  for (const mode of ["light", "dark"]) {
    await page.locator("html").evaluate((element, mode) => {
      element.setAttribute("data-color-mode", mode);
    }, mode);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(preview).toBeVisible();
      await expect(
        preview.getByRole("button", { name: "View activity" }),
      ).toBeVisible();
      const bounds = await preview.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await preview.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`profile-preview-${mode}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await page.locator('[data-channel-id="beta"]').click();
  await expect(panel).toHaveCount(0);
  // Disable removes both registration and profile affordance, not the profile itself.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator(`[data-channel-id="${profileChannelId}"]`).click();
  await avatar.click();
  await expect(profile).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  // Finish the reopened profile's focus handoff and timeline layout before
  // starting read dwell; visible profile content alone proves neither.
  await expect(
    profile.getByRole("region", { name: "Profile details" }),
  ).toBeFocused();
  await settle(page);
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  await history.focus();
  await expect(history).toBeFocused();
  // Complete ordinary read dwell and publication before fixture teardown.
  await expect
    .poll(() => app.report.readPublications.length)
    .toBeGreaterThan(1);
});

test.describe("thread activity", () => {
  test.use({
    threadUnread: true,
    readState: true,
    historyCounts: { alpha: 2, beta: 1 }, // Thread fixtures replace the last two Alpha rows with roots.
  });

  test("thread typing uses the existing route, stays isolated, and opens channel details above the composer", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey(),
      agent = getPublicKey(key);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    await row.hover();
    await row.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    const region = thread.getByRole("region", {
      name: "Agent activity in this thread",
      exact: true,
    });
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: "Agent working", exact: true });
    const sendTyping = (threadId, signingKey = key, secondsAgo = 0) => {
      const event = finalizeEvent(
        {
          kind: 20002,
          created_at: Math.floor(Date.now() / 1000) - secondsAgo,
          content: "",
          tags: [
            ["h", "alpha"],
            ...(threadId
              ? [
                  ["e", threadId, "", "root"],
                  ["e", threadId, "", "reply"],
                ]
              : []),
          ],
        },
        signingKey,
      );
      app.relay.publish("primary", event);
      return event;
    };
    // Owner telemetry recognizes the agent without claiming a working channel turn.
    app.observer(activity("turn_liveness", "alpha", "previous"), key);
    await expect(agentEntry(page, agent)).toBeVisible();
    app.observer(activity("turn_completed", "alpha", "previous"), key);
    await expect(agentEntry(page, agent)).toHaveCount(0);
    sendTyping(root.id, generateSecretKey());
    sendTyping("b".repeat(64));
    await expect(region).toHaveCount(0);
    const typing = sendTyping(root.id);
    await expect(region).toBeVisible();
    await expect(marker).toHaveCount(0); // Thread-only fallback must not light channel scope.
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${typing.id}"]`)).toHaveCount(
      0,
    );
    const entry = region.getByRole("button", {
      name: new RegExp(agent.slice(0, 12)),
    });
    const form = thread.getByRole("form", {
      name: "Reply to thread",
      exact: true,
    });
    const entryBox = await entry.boundingBox(),
      formBox = await form.boundingBox();
    expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(formBox.y);
    expect(formBox.y - entryBox.y - entryBox.height).toBeCloseTo(4, 0);
    const inset = await entry.evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingLeft),
    );
    expect(entryBox.x).toBeCloseTo(formBox.x, 0);
    expect((await entry.locator(".buzz-avatar").boundingBox()).x).toBeCloseTo(
      formBox.x + inset,
      0,
    );
    await entry.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Details show channel activity",
    );
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-above-composer.png"),
    });
    await page.mouse.move(0, 0);
    // A closing tooltip retains its desktop position until its exit completes.
    await expect(
      page.getByRole("tooltip", { includeHidden: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    sendTyping(root.id);
    await expect(entry).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(390);
    const narrowEntry = await entry.boundingBox(),
      narrowForm = await form.boundingBox();
    expect(narrowEntry.y + narrowEntry.height).toBeLessThanOrEqual(
      narrowForm.y,
    );
    expect(narrowForm.y - narrowEntry.y - narrowEntry.height).toBeCloseTo(4, 0);
    expect((await entry.locator(".buzz-avatar").boundingBox()).x).toBeCloseTo(
      narrowForm.x +
        (await entry.evaluate((element) =>
          parseFloat(getComputedStyle(element).paddingLeft),
        )),
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-narrow.png"),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await entry.click();
    await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
    await expect(
      activityPanel(page).getByRole("combobox", {
        name: "Channel",
        exact: true,
      }),
    ).toHaveText(/Alpha.*alpha/);
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    sendTyping();
    await expect(marker).toBeVisible();
    const workingBox = await marker.boundingBox();
    expect(workingBox).toEqual(
      expect.objectContaining({ width: 6, height: 6 }),
    );
    await expect(channelActivity(page)).toBeVisible();
    const channelBox = await channelActivity(page)
      .getByRole("button")
      .first()
      .boundingBox();
    const channelForm = await page
      .getByRole("form", { name: "Send a message to Alpha", exact: true })
      .boundingBox();
    expect(channelBox.y + channelBox.height).toBeLessThanOrEqual(channelForm.y);
    await expect(marker).toHaveCount(0, { timeout: 10_000 });
    await expect(channelActivity(page)).toHaveCount(0);
  });
});
