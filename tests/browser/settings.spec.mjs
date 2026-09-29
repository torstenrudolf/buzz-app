import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });

test("Settings replaces the channel sidenav and Back restores the prior view", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Alpha").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  const communityRail = page.getByRole("navigation", { name: "Communities" });
  await expect(communityRail).toBeVisible();

  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settingsSidebar = page.getByRole("complementary", {
    name: "Settings sidebar",
    includeHidden: true,
  });
  await expect(settingsSidebar).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1, exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toHaveCount(0);
  await expect(communityRail).toBeVisible();

  const notifications = settingsSidebar.getByRole("button", {
    name: "Notifications",
    exact: true,
  });
  await notifications.click();
  await expect(notifications).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await settingsSidebar
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toBeVisible();
  await expect(settingsSidebar).toHaveCount(0);
  await expect(communityRail).toBeVisible();
});

test("short narrow Settings keeps full plugin rows usable at 200% text size", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 400 });
  await page.addInitScript(() =>
    localStorage.setItem("buzz-font-scale.v1", "2"),
  );
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const showNavigation = button(page, "Show navigation");
  await showNavigation.click();
  const settingsSidebar = page.getByRole("complementary", {
    name: "Settings sidebar",
    includeHidden: true,
  });
  await settingsSidebar
    .getByRole("button", { name: "Plugins", exact: true })
    .click();
  const content = page.getByRole("region", { name: "Plugins", exact: true });
  const row = content.getByRole("article").filter({
    has: page.getByRole("switch", { name: "Enable GitHub", exact: true }),
  });
  const toggle = row.getByRole("switch", {
    name: "Enable GitHub",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveCSS("--buzz-text-scale", "2");
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport({ ratio: 1 });
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("settings-short-200-percent.png"),
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeInViewport({ ratio: 1 });
  // The replacement Settings pane remains reachable by disclosure at narrow
  // widths and is persistent at desktop widths.
  await expect(settingsSidebar).toBeHidden();
  await expect(showNavigation).toHaveAttribute("aria-expanded", "false");
  await showNavigation.click();
  await expect(settingsSidebar).toBeVisible();
  const profile = settingsSidebar.getByRole("button", {
    name: "Profile",
    exact: true,
    includeHidden: true,
  });
  await profile.click();
  await expect(profile).toHaveAttribute("aria-current", "page");
  await expect(settingsSidebar).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(settingsSidebar).toBeVisible();
  await expect(showNavigation).toBeHidden();
  await page.setViewportSize({ width: 480, height: 400 });
  await expect(showNavigation).toBeVisible();
  await showNavigation.click();
  await expect(settingsSidebar).toBeVisible();
  await settingsSidebar
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Channels", exact: true }),
  ).toBeVisible();
  const channelsSidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
  });
  await expect(channelsSidebar).toBeHidden();
  await showNavigation.click();
  await expect(channelsSidebar).toBeVisible();
});

test.describe("community administration permissions", () => {
  test("shows Membership to a verified owner", async ({ page, app }) => {
    let rosterGate;
    let rosterStarted = () => {};
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (filters.some((filter) => filter.kinds?.includes(13534))) {
        rosterStarted();
        await rosterGate;
        return route.fulfill({ json: [app.membershipSnapshot("owner")] });
      }
      return route.continue();
    });
    await page.goto(app.origin);
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    await expect(sections).toContainText("Administration");
    // The account menu finishes its focus handoff before testing section focus.
    await expect(page.getByRole("main")).toBeFocused();
    const membership = sections.getByRole("button", {
      name: "Membership",
      exact: true,
    });
    await membership.focus();
    await membership.press("Enter");
    await expect(membership).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Membership", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Invite members" }).click();
    const dialog = page.getByRole("dialog", { name: "Add or invite people" });
    await expect(
      dialog.getByRole("heading", { name: "Add directly" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Invite with a link" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "Public identity" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: /Search people/ }),
    ).toHaveCount(0);

    // Keep browser history/reload, real roster verification, and host wiring real.
    // A held response proves this route cannot fall through to Profile or failure.
    await page.keyboard.press("Escape");
    let releaseRoster;
    rosterGate = new Promise((resolve) => {
      releaseRoster = resolve;
    });
    const started = new Promise((resolve) => {
      rosterStarted = resolve;
    });
    try {
      await page.reload();
      await started;
      await expect(
        page.getByText("Opening destination…", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("This destination couldn’t open", { exact: true }),
      ).toHaveCount(0);
      await expect(
        sections.getByRole("button", { name: "Membership", exact: true }),
      ).toHaveCount(0);
    } finally {
      releaseRoster();
    }
    await expect(
      page.getByRole("heading", { name: "Membership", exact: true }),
    ).toBeVisible();
  });
});

// Only this journey requires a confirmed Online badge/radio. Keep unrelated
// Settings fixtures on their existing synthetic broker.
const confirmedPresence = test.extend({ productionBroker: true });
confirmedPresence(
  "avatar Settings access dismisses cleanly and exposes Profile and Plugins",
  async ({ page, app, browserName }, testInfo) => {
    // macOS WebKit follows the system's text-fields-only Tab preference. Option+Tab
    // includes native buttons; exercise real key traversal, not programmatic focus.
    const tab = (backwards = false) =>
      page.keyboard.press(
        `${browserName === "webkit" && process.platform === "darwin" ? "Alt+" : ""}${backwards ? "Shift+" : ""}Tab`,
      );
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (filters.some((filter) => filter.kinds?.includes(13534)))
        return route.fulfill({ json: [app.membershipSnapshot("member")] });
      return route.continue();
    });
    await page.goto(app.origin);
    const avatar = button(page, "Your profile");
    const account = page.getByRole("menu", {
      name: "Fixture Reader",
    });
    const settings = account.getByRole("menuitem", {
      name: "Settings",
      exact: true,
    });
    const viewProfile = account.getByRole("menuitem", {
      name: "View your profile",
      exact: true,
    });
    const statusEntry = account.getByRole("menuitem", {
      name: "Set a status",
      exact: true,
    });
    const feedback = account.getByRole("menuitem", {
      name: "Send feedback",
      exact: true,
    });
    const availability = account.getByRole("button", {
      name: "Availability: Online",
    });
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("menuitem", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    await expect(avatar.locator(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await avatar.click();
      await expect(account).toBeInViewport();
      await expect(avatar).toHaveAttribute("aria-expanded", "true");
      await expect(availability).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitemradio", { name: "Online", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitemradio", { name: "Away", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("menuitemradio", { name: "Automatic", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("menuitemradio", { name: "Online", exact: true }),
      ).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(availability).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(account).toBeHidden();
      await expect(avatar).toBeFocused();
      await avatar.click();
      await avatar.click();
      await expect(account).toBeHidden();
      await avatar.click();
      // The account popup may cover main’s top-left on narrow layouts.
      // Click the lower content area, genuinely outside the popup.
      const main = page.getByRole("main");
      const bounds = await main.boundingBox();
      await main.click({ position: { x: 5, y: bounds.height - 5 } });
      await expect(account).toBeHidden();
      await avatar.focus();
      await page.keyboard.press("Enter");
      await expect(viewProfile).toBeFocused();
      await page.keyboard.press("End");
      await expect(settings).toBeFocused();
      await page.keyboard.press("Home");
      await expect(viewProfile).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(statusEntry).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(feedback).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settings).toBeFocused();
      await page.keyboard.press("Home");
      await expect(viewProfile).toBeFocused();
      await tab(true);
      await expect(account).toBeHidden();
      await expect(avatar).toBeFocused();
      await tab(true);
      await expect(button(page, "Search Buzz")).toBeFocused();
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await avatar.focus();
    await page.keyboard.press("Enter");
    await expect(viewProfile).toBeFocused();
    await page.keyboard.press("End");
    await expect(settings).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(account).toBeHidden();
    await expect(page.getByRole("main")).toBeFocused();
    const settingsSidebar = page.getByRole("complementary", {
      name: "Settings sidebar",
      includeHidden: true,
    });
    if (await button(page, "Show navigation").isVisible())
      await button(page, "Show navigation").click();
    await expect(settingsSidebar).toBeVisible();
    const sections = settingsSidebar.getByRole("navigation", {
      name: "Settings sections",
      includeHidden: true,
    });
    const profile = sections.getByRole("button", {
      name: "Profile",
      exact: true,
      includeHidden: true,
    });
    const personalGroups = sections.getByRole("button", {
      name: "Personal groups",
      exact: true,
    });
    const customEmoji = sections.getByRole("button", {
      name: "Custom emoji",
      exact: true,
    });
    const hostedCommunities = sections.getByRole("button", {
      name: "Hosted communities",
      exact: true,
    });
    const plugins = sections.getByRole("button", {
      name: "Plugins",
      exact: true,
      includeHidden: true,
    });
    const profileContent = page.getByRole("region", {
      name: "Profile",
      exact: true,
    });
    const pluginContent = page.getByRole("region", {
      name: "Plugins",
      exact: true,
    });
    await expect(profile).toHaveAttribute("aria-current", "page");
    await expect(profileContent).toBeVisible();
    await expect(pluginContent).toHaveCount(0);
    await personalGroups.click();
    await expect(personalGroups).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Personal groups", exact: true }),
    ).toBeVisible();
    await expect(button(page, "Manage personal groups")).toBeVisible();
    await profile.click();
    // Exercise the real shell's destination allowlist, not just the settings component.
    const agents = sections.getByRole("button", {
      name: "Agents",
      exact: true,
    });
    await agents.click();
    await expect(agents).toHaveAttribute("aria-current", "page");
    const remember = page.getByRole("switch", {
      name: "Remember mentioned agents",
    });
    await expect(remember).toBeChecked();
    await remember.click();
    await expect(remember).not.toBeChecked();
    await profile.click();
    await agents.click();
    await expect(remember).not.toBeChecked();
    await profile.click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (await button(page, "Show navigation").isVisible())
        await button(page, "Show navigation").click();
      await expect(settingsSidebar).toBeVisible();
      await profile.focus();
      await tab();
      await expect(personalGroups).toBeFocused();
      await tab();
      await expect(customEmoji).toBeFocused();
      await tab();
      await expect(hostedCommunities).toBeFocused();
      await tab();
      await expect(
        sections.getByRole("button", { name: "Appearance", exact: true }),
      ).toBeFocused();
      await plugins.focus();
      await page.keyboard.press("Enter");
      await expect(plugins).toHaveAttribute("aria-current", "page");
      await expect(profile).not.toHaveAttribute("aria-current");
      if (width === 1280) await expect(plugins).toBeFocused();
      else await expect(page.getByRole("main")).toBeFocused();
      await expect(profileContent).toHaveCount(0);
      await expect(pluginContent).toBeVisible();
      await expect(
        page.getByRole("switch", { name: "Enable Projects" }),
      ).toBeVisible();
      const settingsRegion = page.getByRole("region", {
        name: "Settings",
        exact: true,
      });
      await expect(settingsRegion).toHaveCSS(
        "background-color",
        "rgb(255, 255, 255)",
      );
      await expect(settingsRegion).toHaveCSS("border-radius", "24px");
      const frame = await settingsRegion.boundingBox();
      expect(frame.height).toBeGreaterThan(700);
      if (width === 1280) {
        await expect(settingsSidebar).toBeVisible();
        const navigation = await sections.boundingBox();
        const content = await pluginContent.boundingBox();
        expect(navigation).not.toBeNull();
        expect(content).not.toBeNull();
        expect(navigation.x + navigation.width).toBeLessThan(content.x);
        expect(content.y - frame.y).toBe(25);
      } else {
        await expect(settingsSidebar).toBeHidden();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
      await page.screenshot({
        path: testInfo.outputPath(`settings-${width}.png`),
      });
      if (width === 390) await button(page, "Show navigation").click();
      await profile.focus();
      await expect(profile).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(profile).toHaveAttribute("aria-current", "page");
      await expect(profileContent).toBeVisible();
      await expect(pluginContent).toHaveCount(0);
      if (width === 390) {
        await expect(settingsSidebar).toBeHidden();
        await expect(page.getByRole("main")).toBeFocused();
        await button(page, "Show navigation").click();
        await profile.focus();
      }
      await tab();
      await expect(personalGroups).toBeFocused();
      await tab();
      await expect(customEmoji).toBeFocused();
      await tab();
      await expect(hostedCommunities).toBeFocused();
      await tab();
      await expect(
        sections.getByRole("button", { name: "Appearance", exact: true }),
      ).toBeFocused();
      await tab();
      await expect(
        sections.getByRole("button", { name: "Notifications", exact: true }),
      ).toBeFocused();
      await tab();
      await expect(
        sections.getByRole("button", { name: "Shortcuts", exact: true }),
      ).toBeFocused();
      await tab();
      await expect(agents).toBeFocused();
      await tab();
      await expect(plugins).toBeFocused();
      await tab();
      await expect(
        sections.getByRole("button", { name: "Updates", exact: true }),
      ).toBeFocused();
      await tab();
      // The current profile form begins with its avatar editor before text fields.
      await expect(
        page.getByRole("button", { name: "Edit avatar", exact: true }),
      ).toBeFocused();
    }
  },
);

test("Settings loads and publishes the selected community profile", async ({
  page,
  app,
  browserName,
}) => {
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const writes = [];
  const profiles = [];
  let releaseProfile;
  await page.route("**/api/relay/primary/profile", async (route) => {
    const response = await new Promise((resolve) => {
      releaseProfile = resolve;
    });
    releaseProfile = undefined;
    if (response) await route.fulfill(response);
    else await route.continue();
  });
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url())) {
      writes.push(request.url());
      if (request.url().endsWith("/profile"))
        profiles.push(request.postDataJSON());
    }
  });
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Browser Fixture" }),
  ).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  const profileRegion = () =>
    page.getByRole("region", { name: "Profile", exact: true });
  const displayName = () =>
    profileRegion().getByRole("textbox", { name: "Display name", exact: true });
  const name = displayName();
  const save = () =>
    profileRegion().getByRole("button", { name: "Save", exact: true });
  await expect(name).toHaveValue("Fixture Reader");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button(page, "Edit profile")).toHaveCount(0);
  await name.fill("Do not save");
  await expect(name).toHaveValue("Do not save");
  await button(page, "Plugins").click();
  await expect(name).toBeHidden();
  await button(page, "Profile").click();
  await expect(name).toHaveValue("Do not save");
  await button(page, "Cancel").press("Enter");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Fixture Reader");
  await name.fill("Discard when leaving Settings");
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Browser Fixture" }),
  ).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  const reopenedName = displayName();
  await expect(reopenedName).toHaveValue("Fixture Reader");
  await reopenedName.fill("   ");
  await expect(save()).toBeDisabled();
  await reopenedName.fill("Updated community profile");
  await profileRegion().getByRole("button", { name: "Edit avatar" }).click();
  const avatarEditor = page.getByRole("dialog", { name: "Edit avatar" });
  const picture = avatarEditor.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await picture.fill("http://example.com/avatar.png");
  await expect(
    avatarEditor.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await picture.fill("");
  await avatarEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(avatarEditor).toBeHidden();
  await expect(
    profileRegion().getByRole("button", { name: "Edit avatar", exact: true }),
  ).toBeFocused();
  await expect(save()).toBeEnabled();
  await reopenedName.fill("  Updated community profile  ");
  await save().press("Enter");
  try {
    await expect.poll(() => profiles.length).toBe(1);
    await expect.poll(() => typeof releaseProfile).toBe("function");
    await expect(save()).toHaveAttribute("aria-busy", "true");
    await expect(save()).toBeFocused();
    await expect(reopenedName).toBeDisabled();
    await expect(button(page, "Cancel")).toBeDisabled();
    await page.keyboard.press("Enter");
  } finally {
    releaseProfile?.({
      json: { accepted: false, message: "Publication unavailable" },
    });
  }
  await expect(page.getByRole("alert")).toContainText(
    "Publication unavailable",
  );
  await expect(save()).toBeFocused();
  await expect(save()).toBeEnabled();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => profiles.length).toBe(2);
    await expect.poll(() => typeof releaseProfile).toBe("function");
    await expect(save()).toHaveAttribute("aria-busy", "true");
    await expect(save()).toBeFocused();
  } finally {
    releaseProfile?.();
  }
  await expect(reopenedName).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    profileRegion().getByRole("textbox", {
      name: "Profile description (optional)",
    }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    profileRegion().getByRole("textbox", {
      name: "Public key (hex)",
      exact: true,
    }),
  ).toBeFocused();
  await expect(save()).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Profile updated" }),
  ).toBeVisible();
  await expect(reopenedName).toHaveValue("Updated community profile");
  await button(page, "Your profile").hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Updated community profile",
  );
  await expect(button(page, "Your profile")).toHaveAccessibleDescription(
    "Updated community profile",
  );
  await reopenedName.fill("Discard after saving");
  await button(page, "Cancel").press("Enter");
  await expect(reopenedName).toBeFocused();
  await expect(reopenedName).toHaveValue("Updated community profile");
  await page.reload();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Updated local profile" }),
  ).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  // The fixture updates its signed relay profile on publication; reopening proves
  // Settings re-reads that confirmed community state rather than retaining a draft.
  await expect(displayName()).toHaveValue("Updated community profile");
  await button(page, "Your profile").hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Updated community profile",
  );
  expect(writes.filter((url) => url.endsWith("/profile"))).toHaveLength(2);
  expect(profiles).toHaveLength(2);
  for (const profile of profiles)
    expect(profile).toEqual(
      expect.objectContaining({
        name: "Updated community profile",
        picture: "",
        existing: expect.objectContaining({ name: "Fixture Reader" }),
      }),
    );
});

test("discarding community setup leaves the published profile unchanged", async ({
  page,
  app,
}) => {
  const writes = [];
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url()))
      writes.push(request.url());
  });
  await page.route("**/api/relay/primary/info", (route) =>
    route.fulfill({ json: { name: "Primary", policy: null } }),
  );
  await page.route("https://example.com/avatar.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    }),
  );
  await page.goto(app.origin);
  await button(page, "Add a community").click();
  await page
    .getByRole("textbox", { name: "Relay URL", exact: true })
    .fill("wss://primary.example");
  await button(page, "Continue").click();
  await expect(
    page.getByRole("heading", { name: "Your profile in Primary", exact: true }),
  ).toBeVisible();
  const setup = page.getByRole("dialog").filter({
    has: page.getByRole("heading", {
      name: "Your profile in Primary",
      exact: true,
    }),
  });
  const name = setup.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await expect(name).toHaveValue("Fixture Reader");
  await expect(button(page, "Open community")).toBeEnabled();
  await name.fill("Community-only draft");
  await setup.getByRole("button", { name: "Edit avatar" }).click();
  const avatarEditor = page.getByRole("dialog", { name: "Edit avatar" });
  const picture = avatarEditor.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await picture.fill("http://example.com/avatar.png");
  await expect(
    avatarEditor.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await picture.fill("https://example.com/avatar.png");
  await avatarEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(button(page, "Publish profile & open")).toBeEnabled();
  await button(page, "Close").click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settingsProfile = page.getByRole("region", {
    name: "Profile",
    exact: true,
  });
  await expect(
    settingsProfile.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Fixture Reader");
  await settingsProfile.getByRole("button", { name: "Edit avatar" }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit avatar" }).getByRole("textbox", {
      name: "Picture URL (optional)",
      exact: true,
    }),
  ).toHaveValue("");
  expect(writes).toEqual([]);
});
