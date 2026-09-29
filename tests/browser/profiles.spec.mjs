import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("profile plumbing: exact avatar/mention targets, thread enrichment, lifecycle and recovery", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html");
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await page.waitForFunction(() => !!window.profilesFixture);
  const npubs = await page.evaluate(() => window.profilesFixture.npubs);
  const key = page
    .getByRole("complementary", { name: "Profile", exact: true })
    .locator("code");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  await expect(avatar).toHaveCount(1);
  await expect(avatar.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await avatar.focus();
  await avatar.press("Enter");
  await expect(key).toHaveText(npubs.viewer);
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  const portrait = panel.getByRole("img", { name: "Viewer avatar" });
  await expect(portrait).toBeVisible();
  const name = panel.getByRole("heading", { name: "Viewer", exact: true });
  const portraitWidth = await portrait.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(portraitWidth).toBeCloseTo(80, 0);
  expect(
    await portrait.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeCloseTo(portraitWidth, 0);
  expect(
    await name.evaluate(
      (element, portrait) =>
        element.getBoundingClientRect().left >=
        portrait.getBoundingClientRect().right,
      await portrait.elementHandle(),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.profilesFixture.report.media),
  ).toContainEqual(["https://images.test/avatar.png", undefined]);
  await expect(panel.getByText("Human profile", { exact: true })).toBeVisible();
  // Stub clipboard at the browser boundary: test the UI's exact key and
  // recovery, without relying on OS permission/pasteboard behavior in CI.
  await page.evaluate(() => {
    window.profileCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => window.profileCopies.push(value) },
    });
  });
  await panel.getByRole("button", { name: "Copy npub" }).click();
  await expect(panel.getByRole("status")).toHaveText("Public key copied.");
  expect(await page.evaluate(() => window.profileCopies)).toEqual([
    npubs.viewer,
  ]);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
  });
  await panel.getByRole("button", { name: "Copy npub" }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "Could not copy. Select the public key above to copy it.",
  );
  await expect(key).toHaveText(npubs.viewer);
  await page.getByRole("region", { name: "Profile details" }).press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(avatar).toBeFocused();
  const mention = page.getByRole("button", {
    name: "View Mic profile",
    exact: true,
  });
  await mention.click();
  await expect(key).toHaveText(npubs.mic);
  await expect(panel.getByText("📅 In a meeting")).toBeVisible();
  await expect(panel.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await panel.getByRole("button", { name: "Close channel panel" }).click();
  await expect(mention).toBeFocused();
  await mention.press("Space");
  await expect(key).toHaveText(npubs.mic);
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  expect(
    await page.evaluate(() => window.profilesFixture.report.memoryReads),
  ).toEqual([]);
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "buzz.profiles"),
  );
  await expect(panel).toHaveCount(0);
  const retiredMemoryReads = await page.evaluate(
    () => window.profilesFixture.report.memoryReads,
  );
  await expect(mention).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Channel message history" })
      .getByText("Hello @Mic", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.profilesFixture.change("enable", "buzz.profiles"),
  );
  await expect(mention).toHaveCount(1);
  await expect(panel).toHaveCount(0);
  await page
    .getByRole("button", { name: "View thread: 1 reply", exact: true })
    .click();
  const threadMention = page.getByRole("button", {
    name: "View Pinky profile",
    exact: true,
  });
  await expect(threadMention).toBeVisible();
  await threadMention.click();
  await expect(key).toHaveText(npubs.pinky);
  await expect(panel.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await expect(
    panel.getByRole("img", { name: "Pinky avatar" }),
  ).toHaveAttribute("data-size", "fill");
  await expect(panel.getByText("Agent profile", { exact: true })).toBeVisible();
  // Existing navigation journey also proves row hover/focus affordances and host toast wiring.
  await expect(panel.getByRole("tab", { name: "Memories" })).toBeVisible();
  const agentType = panel.getByRole("button", { name: /^Copy Agent type:/ });
  await expect(agentType).toContainText("Codex");
  const nip05 = panel.getByRole("button", { name: /^Copy NIP-05:/ });
  await expect(nip05).toHaveText("NIP-05pinky@example.test");
  await agentType.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(nip05).toBeFocused();
  await expect(nip05.locator("[data-copied]")).toHaveCSS("opacity", "1");
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) =>
      window.profileCopies.push(value);
  });
  await nip05.press("Enter");
  await expect(page.getByText("Copied nip-05", { exact: true })).toBeVisible();
  await expect(nip05.locator("[data-copied]")).toHaveAttribute(
    "data-copied",
    "true",
  );
  await agentType.click();
  await panel.getByRole("button", { name: /^Copy Capabilities:/ }).click();
  expect(await page.evaluate(() => window.profileCopies.slice(-3))).toEqual([
    "pinky@example.test",
    "codex-acp",
    "code, review",
  ]);

  await expect(panel.getByRole("tab", { name: "Memories" })).toBeVisible();
  await panel.getByRole("tab", { name: "Channels" }).click();
  await expect(panel.getByRole("region", { name: "Channels" })).toContainText(
    "One",
  );
  expect(
    await page.evaluate(() => window.profilesFixture.report.memoryReads),
  ).toEqual(retiredMemoryReads);
  await panel.getByRole("tab", { name: "Memories" }).click();
  const memories = panel.getByRole("region", { name: "Agent memories" });
  await expect(
    memories.getByText("Core memory", { exact: true }),
  ).toBeVisible();
  await memories.getByText("Core memory", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(memories.locator("pre")).toBeVisible();
  await expect(memories.locator("pre")).toContainText(
    "<script>not executable</script>",
  );
  await expect(memories.locator("script")).toHaveCount(0);
  const priorViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect
    .poll(() =>
      memories.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("memories-narrow.png"),
  });
  await page.setViewportSize(priorViewport);
  await panel.getByRole("tab", { name: "Info" }).click();
  await expect(memories).toHaveCount(0);

  await expect(panel.getByRole("region", { name: "Instances" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Close channel panel" }).click();
  await expect(
    page.getByRole("button", { name: "View thread: 1 reply", exact: true }),
  ).toBeFocused();
  const missingKey = await page.evaluate(
    () => window.profilesFixture.keys.missing,
  );
  const unknownAvatar = page.getByRole("button", {
    name: `View ${missingKey.slice(0, 10)} profile`,
  });
  await expect(unknownAvatar.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await unknownAvatar.click();
  await expect(key).toHaveText(npubs.missing);
  await expect(panel.getByText("Could not load this profile.")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Unknown agent", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("img", { name: "Unknown agent avatar" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  // This browser fixture has no native host; the empty loaded inventory case is
  // covered by ProfilePanel.fallback.test.tsx, not an unavailable host.
  await expect(panel.getByRole("region", { name: "Instances" })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Runtime" })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /^(Start|Stop|Restart|Delete agent)$/ }),
  ).toHaveCount(0);
  await page.evaluate(() => window.profilesFixture.recover());
  await panel.getByRole("button", { name: "Retry profile" }).click();
  await expect(panel.getByText("Recovered biography")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Recovered", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("img", { name: "Recovered avatar" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  for (const mode of ["light", "dark"]) {
    if (mode === "dark")
      await page.getByRole("button", { name: "Toggle appearance" }).click();
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(key).toBeVisible();
      const layout = await panel.evaluate((element) => {
        const region = element.querySelector('[aria-label="Profile details"]');
        const key = element.querySelector("code");
        return {
          padding: parseFloat(getComputedStyle(region).paddingLeft),
          overflow: element.scrollWidth > element.clientWidth,
          keyOverflow: key.scrollWidth > key.clientWidth,
        };
      });
      expect(layout.padding).toBeGreaterThanOrEqual(16);
      expect(layout.overflow).toBe(false);
      expect(layout.keyOverflow).toBe(false);
      await panel.screenshot({
        path: testInfo.outputPath(`profile-${mode}-${width}.png`),
      });
    }
  }
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  await page.evaluate(() => window.profilesFixture.replace());
  await expect(panel).toHaveCount(0);
  await expect(page.getByText("Core memory", { exact: true })).toHaveCount(0);
  const reads = await page.evaluate(() => ({
    reads: window.profilesFixture.report.profileReads,
    key: window.profilesFixture.keys.pinky,
  }));
  expect(reads.reads.some((batch) => batch.includes(reads.key))).toBe(true);
  expect(errors.unexplained()).toEqual([]);
});

test("contextual panel callbacks retire with opening, channel, contribution and session", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?context-probe");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  const panel = page.getByRole("complementary", {
    name: "Context probe",
    exact: true,
  });
  const capture = async () => {
    await avatar.click();
    await expect(panel).toBeVisible();
    await page.evaluate(() => {
      window.oldPanelContext = window.profilesFixture.contexts.at(-1);
    });
  };
  const invoke = () =>
    page.evaluate(() =>
      window.oldPanelContext.open(window.profilesFixture.targets.mic),
    );
  await capture();
  expect(await page.evaluate(() => window.oldPanelContext.channelId)).toBe(
    "one",
  );
  expect(await invoke()).toBe(true);
  // A second synchronous use of the old opening must not replace its successor.
  expect(await invoke()).toBe(false);
  await panel.getByRole("button", { name: "Close channel panel" }).click();
  await capture();
  await page.locator('[data-channel-id="two"]').click();
  await expect(panel).toHaveCount(0);
  expect(await invoke()).toBe(false);
  await page.locator('[data-channel-id="one"]').click();
  await capture();
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "context.probe"),
  );
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
  await page.evaluate(() =>
    window.profilesFixture.change("enable", "context.probe"),
  );
  await expect(avatar).toBeVisible();
  expect(await invoke()).toBe(false);
  await capture();
  await page.evaluate(() => window.profilesFixture.replace());
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
  await capture();
  await page.evaluate(() => window.profilesFixture.disconnect());
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
});

// Native button disabling/removal can move focus differently from jsdom. Exercise
// actual keyboard focus in both engines with a gated synthetic host, not real agents.
test("local agent actions retain keyboard focus through pending and success without stealing focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?agent-actions");
  await page
    .getByRole("button", { name: "View Mic profile", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Local agent actions" });
  const start = panel.getByRole("button", { name: "Start", exact: true });
  const stop = panel.getByRole("button", { name: "Stop", exact: true });
  await start.focus();
  await start.press("Enter");
  try {
    await page.waitForFunction(() => window.profilesFixture.launchPending());
    await expect(start).toBeDisabled();
    await expect(start).toBeFocused();
  } finally {
    await page.evaluate(() => window.profilesFixture.finishLaunch());
  }
  await expect(start).toHaveCount(0);
  await expect(stop).toBeFocused();
  await stop.press("Enter");
  await expect(start).toBeEnabled();
  await expect(stop).toBeDisabled();
  await expect(stop).toBeFocused();
  await stop.press("Enter");
  await start.focus();
  await start.press("Enter");
  const copy = page.getByRole("button", { name: "Copy npub" });
  try {
    await page.waitForFunction(() => window.profilesFixture.launchPending());
    await copy.focus();
  } finally {
    await page.evaluate(() => window.profilesFixture.finishLaunch());
  }
  await expect(start).toHaveCount(0);
  await expect(copy).toBeFocused();
  const restart = panel.getByRole("button", { name: "Restart", exact: true });
  await restart.focus();
  await restart.press("Enter");
  try {
    await page.waitForFunction(() => window.profilesFixture.launchPending());
    await expect(restart).toBeDisabled();
    await expect(restart).toBeFocused();
    await restart.press("Enter");
  } finally {
    await page.evaluate(() => window.profilesFixture.finishLaunch());
  }
  await expect(restart).toBeEnabled();
  await expect(restart).toBeFocused();
  expect(await page.evaluate(() => window.profilesFixture.commands())).toEqual([
    "start",
    "stop",
    "start",
    "restart",
  ]);
});

// Switching profile tabs must release the actions view, not its app-owned command.
test("local agent command survives Info tab unmount without stealing tab focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?agent-actions");
  await page
    .getByRole("button", { name: "View Mic profile", exact: true })
    .click();
  const actions = page.getByRole("region", { name: "Local agent actions" });
  await actions
    .getByRole("button", { name: "Start", exact: true })
    .press("Enter");
  const channels = page.getByRole("tab", { name: "Channels", exact: true });
  const info = page.getByRole("tab", { name: "Info", exact: true });
  try {
    await page.waitForFunction(() => window.profilesFixture.launchPending());
    await channels.click();
    await expect(actions).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.profilesFixture.finishLaunch());
  }
  await expect(channels).toBeFocused();
  await info.click();
  await expect(
    actions.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await expect(
    actions.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await expect(info).toBeFocused();
  expect(await page.evaluate(() => window.profilesFixture.commands())).toEqual([
    "start",
  ]);
});

// Real renderer and profile plugin wiring; the fixture substitutes native custody
// and broker signing. Security of those boundaries is covered by IPC/HTTP tests.
// Real browser focus removal and PanelCard Escape bubbling are not modeled by jsdom.
test("keyboard harness log entry focuses Back and restores focus on Back or Escape", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?harness-log");
  const opener = page.getByRole("button", {
    name: "View Mic profile",
    exact: true,
  });
  await opener.focus();
  await opener.press("Enter");
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await profile.getByRole("tab", { name: "Runtime" }).click();
  const entry = profile.getByRole("button", { name: "Harness log" });
  await entry.focus();
  await entry.press("Enter");
  const log = profile.getByRole("region", { name: "Harness log" });
  const back = log.getByRole("button", { name: "Back" });
  await expect(back).toBeFocused();
  await expect(log.getByTestId("managed-agent-log-content")).toHaveText(
    "fixture harness output",
  );
  await back.press("Enter");
  await expect(profile.getByRole("tab", { name: "Runtime" })).toBeVisible();
  await expect(
    profile.getByRole("region", { name: "Profile details" }),
  ).toBeFocused();
  await entry.focus();
  await entry.press("Enter");
  await expect(back).toBeFocused();
  await back.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("focused harness log renders exact local output and exits on disconnect", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?harness-log");
  await page
    .getByRole("button", { name: "View Mic profile", exact: true })
    .click();
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await profile.getByRole("tab", { name: "Runtime" }).click();
  await profile.getByRole("button", { name: "Harness log" }).click();
  const log = profile.getByRole("region", { name: "Harness log" });
  await expect(profile.getByRole("tab", { name: "Runtime" })).toHaveCount(0);
  await expect(log.getByTestId("managed-agent-log-content")).toHaveText(
    "fixture harness output",
  );
  await log.getByRole("button", { name: "Back" }).click();
  await expect(profile.getByRole("tab", { name: "Runtime" })).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "Harness log" }),
  ).toBeVisible();
  await page.evaluate(() => window.profilesFixture.disconnect());
  await expect(profile).toHaveCount(0);
});
