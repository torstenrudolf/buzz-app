import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ savedSidebar: true });

test("sidebar scrollbar starts below the top inset without changing content geometry", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 360 });
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollHeight > viewport.clientHeight,
      ),
    )
    .toBe(true);
  const geometry = await sidebar.evaluate((viewport) => {
    const frame = viewport.parentElement;
    if (!(frame instanceof HTMLElement))
      throw new Error("Missing sidebar frame");
    const mask = getComputedStyle(frame, "::after");
    const panel = viewport.closest("[data-buzz-surface]");
    if (!(panel instanceof HTMLElement))
      throw new Error("Missing sidebar panel");
    return {
      maskTop: Number.parseFloat(mask.top),
      maskHeight: Number.parseFloat(mask.height),
      maskRight: Number.parseFloat(mask.right),
      maskWidth: Number.parseFloat(mask.width),
      maskColor: mask.backgroundColor,
      panelColor: getComputedStyle(panel).backgroundColor,
      paddingTop: Number.parseFloat(getComputedStyle(viewport).paddingTop),
      scrollTop: viewport.scrollTop,
    };
  });
  expect(geometry).toEqual({
    maskTop: 0,
    maskHeight: 24,
    maskRight: 0,
    maskWidth: 5,
    maskColor: geometry.panelColor,
    panelColor: geometry.panelColor,
    paddingTop: 8,
    scrollTop: 0,
  });
});

// Real layout, pointer hover and portaled-menu geometry cannot be proven in jsdom.
// Keep this fixture small; the existing sidebar-unread journeys own overflow scale.
test("compact sidenav keeps its geometry across persistent page navigation", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.getByRole("button", { name: "Alpha", exact: true });
  const panel = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const pages = panel.getByRole("navigation", { name: "Pages" });
  const destinations = [
    "Inbox",
    "Bestie",
    "Projects",
    "Agents",
    "Workflows",
  ].map((name) => pages.getByRole("button", { name, exact: true }));
  const assertDestinationFillParity = async () => {
    const geometry = await Promise.all(
      destinations.map((destination) =>
        destination.evaluate((element) => {
          const panel = element.closest('aside[aria-label="Channel sidebar"]');
          if (!(panel instanceof HTMLElement))
            throw new Error("Missing channel sidebar panel");
          const panelRect = panel.getBoundingClientRect();
          const rowRect = element.getBoundingClientRect();
          return {
            left: rowRect.left - panelRect.left,
            right: panelRect.right - rowRect.right,
            gutter: (() => {
              const scroll = element.closest(
                '[aria-label="Subscribed channels"]',
              );
              return scroll.offsetWidth - scroll.clientWidth;
            })(),
          };
        }),
      ),
    );
    for (const row of geometry) {
      expect(row.left).toBe(13);
      expect(row.right).toBe(row.left + row.gutter);
    }
  };
  await assertDestinationFillParity();
  const before = await alpha.boundingBox();
  expect(before.height).toBe(28);
  const viewportBox = await sidebar.boundingBox();
  const alphaBox = await alpha.boundingBox();
  const overflow = await sidebar.evaluate((viewport) => ({
    clientWidth: viewport.clientWidth,
    scrollWidth: viewport.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  expect(alphaBox.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(alphaBox.x + alphaBox.width).toBeLessThanOrEqual(
    viewportBox.x + viewportBox.width,
  );
  const assertRowFillRounded = async () => {
    const visual = await alpha.evaluate((button) => {
      const row = button.closest("[data-channel-sidebar-row]");
      const viewport = button.closest("nav");
      if (!(row instanceof HTMLElement) || !(viewport instanceof HTMLElement))
        throw new Error("Missing sidebar row geometry");
      const fillStyle = getComputedStyle(row, "::before");
      const rowStyle = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
      const contentRight = viewportRect.right - scrollbarWidth;
      return {
        fillInset:
          contentRight - (rowRect.right - Number.parseFloat(fillStyle.right)),
        leftContentInset: rowRect.left - viewportRect.left,
        rightContentInset: contentRight - rowRect.right,
        radius: fillStyle.borderTopRightRadius,
        overflow: rowStyle.overflow,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
        scrollbarWidth,
      };
    });
    expect(visual.scrollbarWidth).toBe(visual.offsetWidth - visual.clientWidth);
    expect(visual.leftContentInset).toBe(0);
    expect(visual.rightContentInset).toBe(0);
    expect(visual.fillInset).toBe(10);
    expect(Number.parseFloat(visual.radius)).toBeGreaterThan(0);
    expect(visual.overflow).toBe("visible");
  };
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "220px";
  });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollWidth - viewport.clientWidth,
      ),
    )
    .toBe(0);
  const narrowViewport = await sidebar.boundingBox();
  const narrowAlpha = await alpha.boundingBox();
  await assertDestinationFillParity();
  expect(narrowAlpha.x + narrowAlpha.width).toBeLessThanOrEqual(
    narrowViewport.x + narrowViewport.width,
  );
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "260px";
  });
  await expect
    .poll(() => alpha.evaluate((row) => row.getBoundingClientRect().width))
    .toBe(before.width);
  await alpha.hover();
  await expect(
    sidebar.getByRole("button", { name: "More options for Alpha" }),
  ).toHaveCount(0);
  const afterHover = await alpha.boundingBox();
  expect(afterHover.height).toBe(before.height);
  expect(afterHover.width).toBe(before.width);
  await alpha.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(alpha).toBeFocused();
  const node = await sidebar.elementHandle();
  await page
    .getByRole("button", { name: "Agents", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await sidebar.screenshot({ path: info.outputPath(`sidenav-${mode}.png`) });
  }
  await page
    .getByRole("button", { name: "Personal space", exact: true })
    .click();
  // Plugin pages do not need a community, so personal space keeps them enabled.
  for (const destination of destinations)
    await expect(destination).toBeEnabled();
});

// Browser layout and native disclosure behavior are not represented in jsdom.
test("section disclosure toggles content and honors reduced motion", async ({
  page,
  app,
}) => {
  await open(page, app);
  const summary = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Channels$/ });
  const section = summary.locator("xpath=ancestor::*[@data-sidebar-section]");
  const contentId = await summary.getAttribute("aria-controls");
  expect(contentId).toBeTruthy();
  const content = section.locator(`[id="${contentId}"]`);
  const details = section.locator(":scope > div:first-child > details");
  const expanded = await section.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  for (const opening of [false, true]) {
    await summary.click();
    if (opening) await expect(details).toHaveAttribute("open", "");
    else await expect(details).not.toHaveAttribute("open");
    if (opening) await expect(content).not.toHaveAttribute("inert");
    else await expect(content).toHaveAttribute("inert", "");
    await expect
      .poll(() => section.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(opening ? expanded : 28);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await summary.click();
  await expect(details).not.toHaveAttribute("open");
  const durations = await section.evaluate((el) => {
    const content = el.querySelector(":scope > div:last-child");
    const chevron = el.querySelector("summary > span:last-child");
    return [content, chevron].map(
      (element) => getComputedStyle(element).transitionDuration,
    );
  });
  expect(durations).toEqual(["0s", "0s"]);
  expect(
    await section.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(28);
});

// Browser layout verifies the header contract, including inline icon sizing.
test("top bar keeps 28px controls, 16px icons and an 18px Bestie image", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const header = page.locator(".shell-header");
  await expect(header).toBeVisible();
  expect((await header.boundingBox()).height).toBe(48);
  const controls = header.locator(".buzz-button[data-icon-variant]");
  expect(await controls.count()).toBeGreaterThanOrEqual(5);
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect([box.width, box.height]).toEqual([28, 28]);
  }
  const icons = header.locator(
    '.buzz-button[data-icon-variant] svg, .buzz-button[data-icon-variant="chrome"] img:not([src="/bestie.png"])',
  );
  expect(await icons.count()).toBeGreaterThanOrEqual(4);
  for (const icon of await icons.all()) {
    const box = await icon.boundingBox();
    expect([box.width, box.height]).toEqual([16, 16]);
  }
  const bestie = await header.locator('img[src="/bestie.png"]').boundingBox();
  expect([bestie.width, bestie.height]).toEqual([18, 18]);
  await page.screenshot({ path: info.outputPath("top-bar.png") });
});

// Real responsive layout owns the Settings overlay and the desktop sidebar.
test("Settings retains the sidebar toggle across desktop and narrow layouts", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await page.getByRole("button", { name: "Your profile" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const sidebar = page.getByRole("complementary", {
    name: "Settings sidebar",
    exact: true,
  });
  const toggle = page.locator("[data-shell-sidebar-toggle]");
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAccessibleName("Show Channel sidebar");
  await expect(sidebar).not.toBeVisible();
  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const box = await toggle.boundingBox();
  expect([box.width, box.height]).toEqual([28, 28]);
  await toggle.click();
  await expect(sidebar).not.toBeVisible();

  await page.setViewportSize({ width: 600, height: 950 });
  await expect(toggle).toHaveAccessibleName("Show navigation");
  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAccessibleName("Hide navigation");
  await sidebar.getByRole("button", { name: "Back", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(sidebar).not.toBeVisible();
  await expect(toggle).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(toggle).toHaveAccessibleName("Show Channel sidebar");
  await toggle.click();
  await expect(sidebar).toBeVisible();
});

// The shell owns sidebar visibility while the mounted sidebar owns route and width state.
test("shell toggle restores the shared sidebar for Channels and Agents", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", { name: "Communities" });
  const shellNavigation = page.locator("#shell-navigation");
  const sidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const handle = page.getByRole("separator", {
    name: "Resize channel sidebar",
  });
  // Pseudo-element help must paint outside the wrapper for pointer and keyboard.
  for (const activate of [
    () => handle.hover(),
    async () => {
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await handle.focus();
    },
  ]) {
    await activate();
    await expect
      .poll(() =>
        handle.evaluate((node) => {
          const help = getComputedStyle(node, "::before");
          return [help.visibility, help.opacity];
        }),
      )
      .toEqual(["visible", "1"]);
    const help = await handle.evaluate((node) => {
      const style = getComputedStyle(node, "::before");
      const rect = node.getBoundingClientRect();
      const wrapper = node.closest("#shell-navigation");
      return {
        content: style.content,
        right: rect.left + parseFloat(style.left) + parseFloat(style.width),
        wrapperRight: wrapper.getBoundingClientRect().right,
        clip: getComputedStyle(wrapper).clipPath,
        overflow: getComputedStyle(wrapper).overflow,
      };
    });
    expect(help.content).toContain("Drag to resize");
    expect(help.right).toBeGreaterThan(help.wrapperRight);
    expect(help.clip).toBe("none");
    expect(help.overflow).toBe("visible");
  }
  const sidebarNode = await sidebar.elementHandle();
  const expandedWidth = (await sidebar.boundingBox()).width;
  const gutterWidth = await handle.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().width +
      Number.parseFloat(style.marginLeft) +
      Number.parseFloat(style.marginRight)
    );
  });
  const track = await shellNavigation.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      width: node.getBoundingClientRect().width,
      property: style.transitionProperty,
      duration: style.transitionDuration,
    };
  });
  expect(track.width).toBe(expandedWidth + gutterWidth);
  expect(track.property).toContain("width");
  expect(parseFloat(track.duration)).toBeGreaterThan(0);
  const openGap = await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    const main = document.querySelector("#main-content");
    if (!(sidebar instanceof HTMLElement) || !(main instanceof HTMLElement))
      throw new Error("Missing shell panels");
    return (
      main.getBoundingClientRect().left - sidebar.getBoundingClientRect().right
    );
  });
  expect(openGap).toBe(gutterWidth);
  // Seek a paused real transition so runner speed cannot hide an immediate jump.
  for (const label of ["Hide Channel sidebar", "Show Channel sidebar"]) {
    const samples = await page.evaluate(async (label) => {
      const nav = document.querySelector("#shell-navigation");
      const button = document.querySelector(`button[aria-label="${label}"]`);
      const started = new Promise((resolve) => {
        nav.addEventListener("transitionrun", resolve, { once: true });
      });
      button.click();
      await started;
      const animation = nav
        .getAnimations()
        .find((animation) => animation.transitionProperty === "max-width");
      if (!animation) throw new Error("Missing sidebar transition");
      animation.pause();
      try {
        const duration = animation.effect.getTiming().duration;
        const clipping = nav
          .getAnimations()
          .find((animation) => animation.transitionProperty === "clip-path");
        if (!clipping) throw new Error("Missing containment transition");
        clipping.pause();
        try {
          return [0, 0.25, 0.5, 0.75, 1].map((progress) => {
            animation.currentTime = duration * progress;
            clipping.currentTime = duration * progress;
            return {
              width: nav.getBoundingClientRect().width,
              clip: getComputedStyle(nav).clipPath,
            };
          });
        } finally {
          clipping.finish();
          await clipping.finished;
        }
      } finally {
        animation.finish();
        await animation.finished;
      }
    }, label);
    const width = expandedWidth + gutterWidth;
    expect(
      samples.some((sample) => sample.width > 0 && sample.width < width),
    ).toBe(true);
    expect(samples[0].width).toBe(label.startsWith("Hide") ? width : 0);
    expect(samples.at(-1).width).toBe(label.startsWith("Hide") ? 0 : width);
    for (const sample of samples.slice(1, -1))
      expect(sample.clip).toBe("inset(0px)");
    expect(samples.at(-1).clip).toBe(
      label.startsWith("Hide") ? "inset(0px)" : "none",
    );
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      shellNavigation.evaluate(
        (node) => getComputedStyle(node).transitionDuration,
      ),
    )
    .toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await page.getByRole("button", { name: "Show Channel sidebar" }).click();
  await expect
    .poll(() =>
      shellNavigation.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(expandedWidth + gutterWidth);

  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nav = document.querySelector("#shell-navigation");
        const main = document.querySelector("#main-content");
        if (!(nav instanceof HTMLElement) || !(main instanceof HTMLElement))
          throw new Error("Missing shell panels");
        return (
          main.getBoundingClientRect().left - nav.getBoundingClientRect().right
        );
      }),
    )
    .toBe(0);
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show Channel sidebar" }).click();
  await expect(shellNavigation).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(expandedWidth);

  await sidebar.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await expect(sidebar).not.toBeVisible();
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show Channel sidebar" }).click();
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(expandedWidth);
  await expect(
    sidebar.getByRole("button", { name: "Agents", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

// A real grid/overlay measurement is needed: DOM presence misses implicit columns.
// Inbox and Bestie leave companion placement to the shell frame, unlike Messages.
test("Inbox and Bestie pages retain companion layout across navigation and resize", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const pages = page
    .getByRole("complementary", { name: "Channel sidebar", exact: true })
    .getByRole("navigation", { name: "Pages" });
  const launcher = page.locator('.shell-header button[aria-label="Bestie"]');
  const companion = page.getByRole("complementary", {
    name: "Bestie",
    exact: true,
  });
  const checkGeometry = async (body, overlay) => {
    await expect(companion).toBeVisible();
    await expect
      .poll(async () => {
        const card = await companion.boundingBox();
        const bounds = await body.boundingBox();
        if (!card || !bounds) return false;
        return overlay
          ? Math.abs(card.x + card.width - bounds.x - bounds.width) < 2 &&
              card.x < bounds.x + bounds.width
          : card.x >= bounds.x + bounds.width;
      })
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(page.viewportSize().width);
  };
  const showNavigation = async () => {
    if (page.viewportSize().width <= 650)
      await expect(
        page.locator("[data-shell-sidebar-toggle]"),
      ).toHaveAccessibleName(/^(Show|Hide) navigation$/);
    const show = page.getByRole("button", {
      name: "Show navigation",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
  };
  const selectChannel = async (name) => {
    await showNavigation();
    await sidebar.getByRole("button", { name, exact: true }).click();
  };
  const openPage = async (name) => {
    await showNavigation();
    await pages.getByRole("button", { name, exact: true }).click();
    const body = page.getByRole("region", { name, exact: true });
    await expect(
      body.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    return body;
  };
  for (const width of [1440, 900, 600]) {
    await page.setViewportSize({ width, height: 950 });
    let body = await openPage("Inbox");
    await launcher.click();
    await checkGeometry(body, width <= 1000);
    body = await openPage("Bestie");
    await checkGeometry(body, width <= 1000);
    await launcher.click();
    await expect(companion).not.toBeVisible();
    await selectChannel("Alpha");
    await launcher.click();
    body = await openPage("Inbox");
    await checkGeometry(body, width <= 1000);
    await launcher.click();
  }
});

// Real text layout: a rename changes scrollWidth without resizing the label box.
test("channel name fades follow renames without resizing the sidebar", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.locator('button[data-channel-id="alpha"]');
  const label = alpha.getByText("Alpha", { exact: true });
  const labelNode = await label.elementHandle();
  const originalWidth = await label.evaluate((element) => element.clientWidth);
  const sidebarWidth = (await sidebar.boundingBox()).width;
  await expect(label).not.toHaveAttribute("data-overflowing");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await settings.getByText("Diagnostics", { exact: true }).click();
  for (const [name, overflow] of [
    [
      "A very long renamed channel that cannot possibly fit in this fixed width sidebar",
      true,
    ],
    ["Alpha", false],
  ]) {
    app.renameChannel("alpha", name);
    await settings
      .getByRole("button", { name: "Refresh channels", exact: true })
      .click();
    const renamed = alpha.getByText(name, { exact: true });
    await expect(renamed).toBeVisible();
    expect(await labelNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(await renamed.evaluate((element) => element.clientWidth)).toBe(
      originalWidth,
    );
    expect((await sidebar.boundingBox()).width).toBe(sidebarWidth);
    expect(
      await renamed.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(overflow);
    if (overflow)
      await expect(renamed).toHaveAttribute("data-overflowing", "true");
    else await expect(renamed).not.toHaveAttribute("data-overflowing");
  }
});

const fillSidebar = test.extend({
  dmLabels: true,
  sessionChannels: ["alpha"],
  sessionParents: { alpha: "11111111-1111-4111-8111-111111111111" },
});

// Fill lives on the channel wrapper pseudo-element but directly on ordinary and
// nested navigation rows. Real browser geometry verifies those paints align.
fillSidebar(
  "all sidenav row fills share visible inline bounds",
  async ({ page, app }) => {
    await page.goto(app.origin);
    const sidebar = page.getByRole("complementary", {
      name: "Channel sidebar",
    });
    const list = page.getByRole("navigation", { name: "Subscribed channels" });
    const rows = {
      destination: sidebar.getByRole("button", {
        name: "Projects",
        exact: true,
      }),
      channel: sidebar.getByRole("button", { name: "Beta", exact: true }),
      dm: sidebar.getByRole("button", { name: "Alice Fixture", exact: true }),
      session: sidebar.getByRole("button", { name: /Alpha, session in/ }),
    };
    const fillBounds = (row) =>
      row.evaluate((button) => {
        const wrapper = button.closest("[data-channel-sidebar-row]");
        const target = wrapper ?? button;
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(
          target,
          wrapper ? "::before" : undefined,
        );
        const inset = (value) => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : 0;
        };
        return {
          left: rect.left + inset(style.left),
          right: rect.right - inset(style.right),
          containerLeft: rect.left,
          containerRight: rect.right,
        };
      });
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 900 });
      // Resizing is asynchronous in WebKit; assert the complete applied layout.
      await expect(async () => {
        const bounds = Object.fromEntries(
          await Promise.all(
            Object.entries(rows).map(async ([key, row]) => {
              await expect(row).toBeVisible();
              return [key, await fillBounds(row)];
            }),
          ),
        );
        expect(
          bounds.destination.left - bounds.destination.containerLeft,
        ).toBeCloseTo(0, 0);
        expect(
          bounds.destination.containerRight - bounds.destination.right,
        ).toBeCloseTo(0, 0);
        const listBounds = await list.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        });
        expect(bounds.destination.left - listBounds.left).toBeCloseTo(4, 0);
        expect(
          listBounds.right - bounds.destination.right,
        ).toBeGreaterThanOrEqual(4);
        for (const bound of Object.values(bounds)) {
          expect(bound.left).toBeCloseTo(bounds.destination.left, 0);
          expect(bound.right).toBeCloseTo(bounds.destination.right, 0);
        }
      }).toPass({ timeout: 10_000 });
    }

    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("complementary", {
      name: "Settings sidebar",
    });
    const back = settings.getByRole("button", { name: "Back", exact: true });
    const profile = settings.getByRole("button", {
      name: "Profile",
      exact: true,
    });
    await expect(profile).toHaveAttribute("aria-current", "page");
    expect(await fillBounds(profile)).toEqual(await fillBounds(back));
  },
);

// Wheel scrolling and clipping in a short viewport require a real layout engine.
test("non-ready sidebar keeps page rows and Retry reachable by pointer scrolling", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 220 });
  await page.route("**/session", (route) => route.fulfill({ json: {} }));
  await page.goto(app.origin);
  const sidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const retry = sidebar.getByRole("button", {
    name: "Retry channels",
    exact: true,
  });
  await expect(retry).toBeAttached();
  const scrollToBottom = async (target) => {
    await sidebar.hover();
    await page.mouse.wheel(0, 800);
    await expect
      .poll(async () => {
        const bounds = await sidebar.boundingBox();
        const row = await target.boundingBox();
        return (
          !!bounds &&
          !!row &&
          row.y >= bounds.y &&
          row.y + row.height <= bounds.y + bounds.height
        );
      })
      .toBe(true);
  };
  const expectUnclippedFocus = async (button) => {
    await page.keyboard.press("Tab");
    await button.focus();
    await expect(button).toBeFocused();
    await expect
      .poll(() =>
        button.evaluate((element) => {
          const style = getComputedStyle(element);
          const extent =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          let scroll = element.parentElement;
          while (scroll && getComputedStyle(scroll).overflowY !== "auto")
            scroll = scroll.parentElement;
          if (!scroll || style.outlineStyle === "none" || extent <= 0)
            return false;
          const row = element.getBoundingClientRect();
          const clip = scroll.getBoundingClientRect();
          return (
            row.left - extent >= clip.left &&
            row.right + extent <= clip.left + scroll.clientWidth
          );
        }),
      )
      .toBe(true);
  };
  await scrollToBottom(retry);
  await expectUnclippedFocus(retry);
  await expect
    .poll(() =>
      retry.evaluate((element) => {
        const style = getComputedStyle(element);
        const extent =
          parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        return (
          element.getBoundingClientRect().bottom + extent <=
          element.parentElement.getBoundingClientRect().bottom
        );
      }),
    )
    .toBe(true);
  await page.unroute("**/session");
  await retry.click();
  await expect(
    page.getByRole("navigation", { name: "Subscribed channels" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Personal space", exact: true })
    .click();
  const status = sidebar.getByText("Choose a community to see channels.", {
    exact: true,
  });
  await expect(status).toBeAttached();
  await scrollToBottom(status);
  await expectUnclippedFocus(
    sidebar.getByRole("button", { name: "Workflows", exact: true }),
  );
  await sidebar.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
});
