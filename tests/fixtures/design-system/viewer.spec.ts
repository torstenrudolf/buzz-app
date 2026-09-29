import { expect, test, type Locator } from "@playwright/test";
import { watchPageErrors } from "../../browser/page-errors.mjs";
import { COMPONENTS } from "../../../src/shared/design-system/ui/registry";
import { PHOSPHOR_ICONS } from "../../../src/shared/design-system/icons/inventory";

const viewer = "/tests/fixtures/design-system.html";

test("badge motion centered pill scales with its avatar and reverses without jumping", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
  await page.goto("/tests/fixtures/design-system/thinking-avatar.html");
  const card = page.getByRole("article", {
    name: "Centered Start pill",
    exact: true,
  });
  const ink = card.locator(".badge-pill-ink");
  const root = card.locator(".badge-pill-root");
  const dots = card.locator(".badge-pill-dots");
  const artwork = card.locator(".badge-motion-artwork");
  const restMask = await artwork.getAttribute("style");
  const notch = card.locator(".badge-pill-notch");
  const checkJoins = async () => {
    const path = await notch.getAttribute("d");
    expect(path?.match(/ C /g)).toHaveLength(2);
    expect(path).not.toMatch(/NaN|Infinity/);
    await expect(artwork).toHaveAttribute("style", restMask ?? "");
  };
  await card.getByRole("button", { name: "Thinking", exact: true }).click();
  await page.clock.runFor(150);
  await checkJoins();
  await expect(dots).toHaveCSS("opacity", "1");
  await expect(root).toHaveAttribute("data-phase", "morphing");
  const middle = await ink.getAttribute("style");
  await card.getByRole("button", { name: "Available", exact: true }).click();
  expect(await ink.getAttribute("style")).toBe(middle);
  await page.clock.runFor(150);
  await expect(dots).toHaveCSS("opacity", "0");
  await expect(root).toHaveAttribute("data-phase", "morphing");
  await page.clock.runFor(170);
  await expect(root).toHaveAttribute("data-phase", "available");
  await expect(artwork).toHaveAttribute("style", restMask ?? "");
  await expect(ink).toHaveCSS("width", "22px");
  await card.getByRole("button", { name: "Thinking", exact: true }).click();
  await page.clock.runFor(320);
  await checkJoins();
  const metrics = await card.locator(".badge-pill-measure").evaluate((el) => ({
    width: (el as HTMLElement).offsetWidth,
    height: (el as HTMLElement).offsetHeight,
  }));
  const actual = await ink.boundingBox();
  expect(actual?.width).toBeCloseTo(metrics.width, 0);
  expect(actual?.height).toBeCloseTo(metrics.height, 0);
  await expect(ink).toHaveCSS("left", "44px");
  await expect(ink).toHaveCSS("top", "88px");
  const dot = card.locator(".badge-pill-dots i").first();
  const dotWidth = (await dot.boundingBox())?.width ?? 0;
  expect(dotWidth).toBeGreaterThan(0);
  // Exercise actual renderer sizing, including a profile portrait.
  for (const size of [24, 32, 40, 80, 88, 256]) {
    await page
      .getByRole("combobox", { name: "Avatar size" })
      .selectOption(String(size));
    await page.clock.runFor(320);
    const scaled = await ink.boundingBox();
    const detailScale = (size / 88) * Math.sqrt(Math.min(1, 88 / size));
    expect(scaled?.width).toBeCloseTo(metrics.width * detailScale, 0);
    expect(scaled?.height).toBeCloseTo(metrics.height * detailScale, 0);
    expect((await dot.boundingBox())?.width).toBeCloseTo(
      dotWidth * detailScale,
      1,
    );
    const avatar = await artwork.boundingBox();
    expect((scaled?.y ?? 0) + (scaled?.height ?? 0) / 2).toBeCloseTo(
      (avatar?.y ?? 0) + size,
      0,
    );
    await checkJoins();
    await card.getByRole("button", { name: "Available", exact: true }).click();
    await page.clock.runFor(320);
    const restingBadge = await ink.boundingBox();
    expect(restingBadge?.width).toBeCloseTo(size / 4, 1);
    expect((restingBadge?.x ?? 0) + (restingBadge?.width ?? 0) / 2).toBeCloseTo(
      (avatar?.x ?? 0) + size * 0.85,
      1,
    );
    expect(
      (restingBadge?.y ?? 0) + (restingBadge?.height ?? 0) / 2,
    ).toBeCloseTo((avatar?.y ?? 0) + size * 0.85, 1);
    await checkJoins();
    await card.getByRole("button", { name: "Thinking", exact: true }).click();
    await page.clock.runFor(320);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.getByRole("button", { name: "Available", exact: true }).click();
  await page.clock.runFor(20);
  await expect(root).toHaveAttribute("data-phase", "available");
});

test("status badges keep avatar sizes and show a clear cutout in both modes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/avatar`);
  const badges = page.locator(
    '.buzz-avatar-status[data-shape="circle"][data-status]',
  );
  await expect(badges).toHaveCount(5);
  await expect(
    page.getByRole("img", { name: "Morgan Martin, online" }),
  ).toHaveCount(3);
  await expect(
    page.getByRole("img", { name: "Morgan Martin, away" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("img", { name: "Morgan Martin, offline" }),
  ).toHaveCount(1);
  for (const [index, size] of [24, 32, 40].entries()) {
    const badge = badges.nth(index);
    const avatar = badge.locator(".buzz-avatar");
    const dot = badge.locator(".buzz-avatar-status-dot");
    await expect(avatar).toHaveCSS("width", `${size}px`);
    await expect(avatar).toHaveCSS("height", `${size}px`);
    await expect(dot).toHaveCSS("width", `${size / 4}px`);
    await expect(avatar).toHaveCSS("mask-image", /^url\(/);
    const placement = await badge.evaluate((el) => {
      const art = el.querySelector(".buzz-avatar")?.getBoundingClientRect();
      const point = el
        .querySelector(".buzz-avatar-status-dot")
        ?.getBoundingClientRect();
      if (!art || !point) throw new Error("Status avatar parts are missing");
      return [
        point.x + point.width / 2 - art.x,
        point.y + point.height / 2 - art.y,
      ];
    });
    expect(placement[0]).toBeCloseTo(size * 0.85, 1);
    expect(placement[1]).toBeCloseTo(size * 0.85, 1);
  }
  const plain = page
    .locator(".component-specimen")
    .filter({ hasText: "large · no badge" })
    .locator(".buzz-avatar");
  await expect(plain).toHaveCSS("mask-image", "none");
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [index, size] of [24, 32, 40].entries()) {
      await expect(badges.nth(index).locator(".buzz-avatar")).toHaveCSS(
        "width",
        `${size}px`,
      );
    }
  }

  const large = badges.nth(2);
  await expect(large.locator("img")).toHaveAttribute("data-loaded", "true");
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    for (const [status, color] of Object.entries(
      mode === "light"
        ? {
            online: "rgb(33, 131, 88)",
            away: "rgb(255, 186, 24)",
            offline: "rgb(128, 128, 128)",
          }
        : {
            online: "rgb(61, 214, 140)",
            away: "rgb(255, 214, 10)",
            offline: "rgb(164, 164, 164)",
          },
    )) {
      const dot = page
        .locator(
          `.buzz-avatar-status[data-status="${status}"] .buzz-avatar-status-dot`,
        )
        .first();
      await expect(dot).toHaveCSS("background-color", color);
      await expect(dot).toHaveCSS("background-image", "none");
      await expect(dot).toHaveCSS("box-shadow", "none");
    }
    // Only Online retains an outline. Away and Offline expose solid fills. Check
    // the actual CSS paint stack in the browser, including squircle masks.
    for (const status of ["online", "away", "offline"]) {
      const dots = page.locator(
        `.buzz-avatar-status[data-status="${status}"] .buzz-avatar-status-dot`,
      );
      const centers = await dots.evaluateAll((elements) =>
        elements.map((element) => {
          const outer = getComputedStyle(element);
          const inner = getComputedStyle(element, "::after");
          return {
            content: inner.content,
            inset: inner.inset,
            color: inner.backgroundColor,
            mask: inner.maskImage,
            outerMask: outer.maskImage,
          };
        }),
      );
      for (const center of centers) {
        if (status !== "online") {
          expect(center.content).toBe("none");
        } else {
          expect(center.content).toBe('""');
          expect(center.inset).toBe("1px");
          expect(center.mask).toBe(center.outerMask);
          expect(center.color).toBe(
            mode === "light" ? "rgb(43, 154, 102)" : "rgb(51, 176, 116)",
          );
        }
      }
    }
    const box = await large.boundingBox();
    if (!box) throw new Error("Large status avatar is not visible");
    const clip = {
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: Math.ceil(box.x + box.width) - Math.floor(box.x),
      height: Math.ceil(box.y + box.height) - Math.floor(box.y),
    };
    const png = await page.screenshot({ clip });
    const paint = await page.evaluate(
      async ({ base64, box, clip }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas context is unavailable");
        context.drawImage(image, 0, 0);
        const pixel = (x: number, y: number) =>
          [
            ...context.getImageData(
              Math.floor(box.x - clip.x + x),
              Math.floor(box.y - clip.y + y),
              1,
              1,
            ).data,
          ].slice(0, 3);
        return {
          background: pixel(39, 39),
          gap: pixel(28, 34),
          dot: pixel(34, 34),
          artwork: pixel(18, 20),
        };
      },
      { base64: png.toString("base64"), box, clip },
    );
    const difference = (a: number[], b: number[]) =>
      Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? 0))));
    expect(difference(paint.gap, paint.background), `${mode} gap`).toBeLessThan(
      12,
    );
    expect(
      difference(paint.dot, mode === "light" ? [43, 154, 102] : [51, 176, 116]),
      `${mode} rendered step-10 center`,
    ).toBeLessThan(3);
    expect(
      difference(paint.dot, paint.background),
      `${mode} dot`,
    ).toBeGreaterThan(30);
    expect(
      difference(paint.artwork, paint.background),
      `${mode} artwork`,
    ).toBeGreaterThan(30);
  }
});

test("agent status badges follow the squircle while keeping the artwork size", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/avatar`);
  const badges = page.locator(
    '.buzz-avatar-status[data-shape="squircle"][data-status]',
  );
  await expect(badges).toHaveCount(5);
  for (const [index, size] of [24, 32, 40].entries()) {
    const avatar = badges.nth(index).locator(".buzz-avatar");
    await expect(avatar).toHaveCSS("width", `${size}px`);
    await expect(avatar).toHaveCSS("height", `${size}px`);
    await expect(avatar).toHaveCSS("mask-image", /^url\(/);
    await expect(
      badges.nth(index).locator(".buzz-avatar-status-dot"),
    ).toHaveCSS("width", `${size / 4}px`);
    await expect(
      badges.nth(index).locator(".buzz-avatar-status-dot"),
    ).toHaveCSS("mask-image", /^url\(/);
  }
  for (const status of ["online", "away", "offline"]) {
    await expect(
      page.getByRole("img", { name: `Agent artwork, ${status}` }),
    ).toHaveCount(status === "online" ? 3 : 1);
  }
  const plain = page
    .locator(".component-specimen")
    .filter({ hasText: 'shape="squircle"' })
    .first()
    .locator(".buzz-avatar");
  await expect(plain).toHaveCSS("mask-image", /^url\(/);
  expect(
    await plain.evaluate((element) => getComputedStyle(element).maskImage),
  ).not.toBe(
    await badges
      .first()
      .locator(".buzz-avatar")
      .evaluate((element) => getComputedStyle(element).maskImage),
  );
});

test("loaded avatar artwork stays mounted through status changes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/avatar`);
  const group = page.locator(".component-specimen-group").filter({
    has: page.getByRole("heading", { name: "Status transitions" }),
  });
  const artwork = group.locator(".buzz-avatar img");
  await expect(artwork).toHaveAttribute("data-loaded", "true");
  await expect(artwork).toHaveCSS("opacity", "1");
  await artwork.evaluate((image) =>
    image.setAttribute("data-test-instance", "retained"),
  );
  for (const status of ["online", "away", "offline"] as const) {
    await group.getByRole("button", { name: `Set ${status}` }).click();
    await expect(
      group.getByRole("img", { name: `Live agent artwork, ${status}` }),
    ).toBeVisible();
    await expect(artwork).toHaveAttribute("data-test-instance", "retained");
    await expect(artwork).toHaveAttribute("data-loaded", "true");
    await expect(artwork).toHaveCSS("opacity", "1");
  }
  await group.getByRole("button", { name: "Clear status" }).click();
  await expect(
    group.getByRole("img", { name: "Live agent artwork", exact: true }),
  ).toBeVisible();
  await expect(artwork).toHaveAttribute("data-test-instance", "retained");
  await expect(artwork).toHaveAttribute("data-loaded", "true");
  await expect(artwork).toHaveCSS("opacity", "1");
});

test("built viewer loads every specimen and foundation without app connections", async ({
  page,
}) => {
  const failures: string[] = [];
  const sockets: string[] = [];
  const pageErrors = watchPageErrors(page);
  page.on("response", (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(viewer);
  await expect(
    page.getByRole("heading", { name: "Buzz Design System", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Design system" });
  for (const component of COMPONENTS) {
    await nav.getByRole("link", { name: component.name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: component.name, exact: true }).first(),
    ).toBeVisible();
  }
  for (const name of [
    "Color",
    "Token table",
    "Typography",
    "Icons",
    "Spacing",
    "Radius",
    "Elevation",
    "Floating surfaces",
    "Glass",
    "Motion",
    "Base UI backing",
    "Foundation alignment",
    "Maintaining the system",
    "DESIGN.md",
    "AGENTS.md",
  ]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page.locator("main h1")).toBeVisible();
    await page.reload();
    await expect(page.locator("main h1")).toBeVisible();
    if (name === "Token table") {
      // Document width alone misses status text colliding with a swatch.
      for (const mode of ["dark", "light"]) {
        const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
        if (await toggle.count()) await toggle.click();
        for (const width of [390, 800, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          const row = page
            .getByRole("row")
            .filter({ hasText: "bg-affordance-panel-hover" });
          const status = row
            .getByText("proposed", { exact: true })
            .filter({ visible: true });
          await expect(status).toHaveCount(1);
          const swatch = row
            .locator("td")
            .last()
            .locator("[aria-hidden]")
            .first();
          await expect(swatch).toBeVisible();
          await expect
            .poll(async () => {
              const labelBox = await status.boundingBox();
              const swatchBox = await swatch.boundingBox();
              return (
                !!labelBox &&
                !!swatchBox &&
                labelBox.x + labelBox.width <= swatchBox.x
              );
            })
            .toBe(true);
        }
      }
    }
  }
  await expect(
    nav.getByRole("link", { name: /Conversation|Agent work/ }),
  ).toHaveCount(0);
  expect([...pageErrors.unexplained(), ...failures]).toEqual([]);
  expect(sockets).toEqual([]);
});

test("composer documents interactive, pending, failure and narrow states", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/composer`);
  const interactive = page.getByRole("form", { name: "Interactive message" });
  const input = interactive.getByRole("textbox", {
    name: "Interactive message",
  });
  const send = interactive.getByRole("button", { name: "Send message" });

  await expect(send).toBeDisabled();
  await input.fill("Ready to review");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toHaveValue("");
  await expect(interactive.getByRole("status")).toHaveText(
    "Message sent in this local preview.",
  );

  const sending = page.getByRole("form", { name: "Sending message" });
  await expect(sending).toHaveAttribute("aria-busy", "true");
  await expect(
    sending.getByRole("button", { name: "Sending message" }),
  ).toBeDisabled();

  const failed = page.getByRole("form", { name: "Message with error" });
  await expect(failed.getByRole("alert")).toContainText(
    "Custom emoji could not be prepared.",
  );
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed.getByRole("alert")).toHaveCount(0);
  await expect(failed.getByRole("status")).toHaveText(
    "Message preparation recovered.",
  );

  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("form", { name: "Narrow message" }),
    ).toBeVisible();
  }
});

test("icon inventory is routed, complete, decorative, and responsive", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/icons`);
  await expect(
    page.getByRole("heading", { name: "Icons", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/design\/icons$/);

  const phosphorList = page.getByRole("list", {
    name: "Available Phosphor icons",
  });
  await expect(phosphorList.getByRole("listitem")).toHaveCount(
    PHOSPHOR_ICONS.length,
  );
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.locator("main svg:not([aria-hidden='true'])")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Open GitHub issue", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Microsoft OneDrive link", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("22 × 22px", { exact: true })).toBeVisible();
  await expect(page.getByText("14 × 14px", { exact: true })).toBeVisible();
  // CSS visibility alone misses captions hidden from assistive technology.
  for (const [meaning, caption] of [
    ["Open GitHub issue", "22 × 22px"],
    ["Microsoft OneDrive link", "14 × 14px"],
  ] as const) {
    const example = page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: meaning, exact: true }),
      })
      .locator(".custom-icon-examples");
    await expect(example).toMatchAriaSnapshot(`- text: ${caption}`);
  }

  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(phosphorList.getByRole("listitem").first()).toBeVisible();
  }
});

test("foundation proposals are independent, local, and usable in both modes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/foundation-alignment`);
  const current = page.getByRole("region", {
    name: "Current tokens",
    exact: true,
  });
  const proposal = page.getByRole("region", {
    name: "Selected proposal",
    exact: true,
  });
  const color = page.getByRole("switch", { name: "Status color" });
  const reading = page.getByRole("switch", { name: "Larger reading text" });
  const spacing = page.getByRole("switch", { name: "More section space" });

  for (const mode of ["light", "dark"]) {
    const theme = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await theme.count()) await theme.click();
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "14px",
    );
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    const neutral = await current
      .locator("[data-status]")
      .evaluate((el) => getComputedStyle(el).color);
    await expect(proposal.locator("[data-status]")).toHaveCSS("color", neutral);

    await color.click();
    await expect(proposal.locator("[data-status]")).not.toHaveCSS(
      "color",
      neutral,
    );
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "14px",
    );
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    await reading.focus();
    await page.keyboard.press("Space");
    await expect(reading).toBeChecked();
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "20px",
    );
    await spacing.click();
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "64px",
    );
    await expect(current.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "14px",
    );
    await expect(current.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    await expect(current.locator("[data-status]")).toHaveCSS("color", neutral);

    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("table")).toHaveCount(3);
      await expect(page.getByRole("table").first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await color.click();
    await reading.click();
    await spacing.focus();
    await page.keyboard.press("Space");
    await expect(spacing).not.toBeChecked();
  }
  await proposal
    .getByRole("button", { name: "Follow project", exact: true })
    .click();
  await expect(
    proposal.getByRole("button", { name: "Following project" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    current.getByRole("button", { name: "Follow project", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(color).not.toBeChecked();
  await expect(reading).not.toBeChecked();
  await expect(spacing).not.toBeChecked();
});

test("narrow, intermediate and wide layouts preserve theme and keyboard interaction", async ({
  page,
  browserName,
}) => {
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${viewer}#/design/components/button`);
    const toggle = page.getByRole("button", { name: "Use dark mode" });
    if (await toggle.count()) await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Use light mode" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  const primary = page.getByRole("button", {
    name: "prominent lg",
    exact: true,
  });
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "subtle xs", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "subtle xs", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
});

test("switch keyboard activation matches pointer state and focus in both modes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const control = switches.nth(0);
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["light", "dark"]) {
      const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
      if (await toggle.count()) await toggle.click();
      await expect(control).not.toBeChecked();
      await control.click();
      await expect(control).toBeChecked();
      await expect(control).toHaveCSS("outline-style", "none");
      await page.keyboard.press(tab);
      await expect(switches.nth(1)).toBeFocused();
      await page.keyboard.press(`Shift+${tab}`);
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "none");
      await page.keyboard.press("Space");
      await expect(control).not.toBeChecked();
      await page.keyboard.press("Enter");
      await expect(control).toBeChecked();
      await control.click();
      await expect(control).not.toBeChecked();
    }
  }
});

test("disabled switch exposes its state, skips Tab and rejects activation", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const disabled = switches.nth(2);
  await expect(disabled).toBeDisabled();
  await expect(disabled).not.toBeChecked();
  await switches.nth(1).click();
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(disabled).not.toBeFocused();
  await disabled.click({ force: true });
  await disabled.press("Space");
  await disabled.press("Enter");
  await expect(disabled).not.toBeChecked();
});

test("viewer does not replace host styles or appearance ownership", async ({
  page,
  context,
}) => {
  const settings = `/#buzz=${encodeURIComponent(JSON.stringify({ version: 1, kind: "settings" }))}`;
  await page.goto(`http://localhost:1444${settings}`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const readHost = () =>
    page.evaluate(() => ({
      storage: JSON.stringify(
        Object.entries(localStorage)
          .filter(([key]) => key !== "buzz-design-viewer-color-scheme")
          .sort(),
      ),
      mode: document.documentElement.getAttribute("data-color-mode"),
      background: getComputedStyle(document.body).backgroundColor,
      systemToken: getComputedStyle(document.documentElement).getPropertyValue(
        "--purple-9",
      ),
    }));
  const before = await readHost();
  expect(before.systemToken.trim()).toBe("#8e4ec6");
  await page.goto(`http://localhost:1445${settings}`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const sameOriginBefore = await readHost();
  const other = await context.newPage();
  await other.goto(`http://localhost:1445${viewer}`);
  await other.getByRole("button", { name: /Use (dark|light) mode/ }).click();
  expect(await readHost()).toEqual(sameOriginBefore);
  await other.close();
});

test("documentation retains table guidance and storage failure stays usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage denied");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage denied");
    };
  });
  await page.goto(`${viewer}#/design/design-guide`);
  // A real cell in a real row, so run-on prose or a dropped table both fail.
  const roleRow = page
    .locator("main table tbody tr")
    .filter({ hasText: "Component recipes and product screens." });
  await expect(roleRow.locator("td").first()).toHaveText("Roles");
  await expect(
    page.locator("main table thead th").filter({ hasText: "Layer" }),
  ).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("|---|");
  // A token is one word: it may sit on its own line, never break across two.
  const split = await page
    .locator("main table code")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 1)
        .map((node) => node.textContent ?? ""),
    );
  expect(split).toEqual([]);
  await expect(page.getByRole("status")).toContainText(
    "Appearance is temporary",
  );
  const before = await page.locator("html").getAttribute("class");
  await page.getByRole("button", { name: /Use (light|dark) mode/ }).click();
  await expect
    .poll(() => page.locator("html").getAttribute("class"))
    .not.toBe(before);
  await expect(page.getByRole("status")).toContainText("Toggle again to retry");
});

test("built component references retain anatomy and fallback identity", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/tabs`);
  const selectedTabRow = page
    .locator("tbody tr")
    .filter({ hasText: "Unselected tab" })
    .first();
  await expect(selectedTabRow).toContainText("text-subtle");
  await expect(selectedTabRow.locator("td")).toHaveCount(6);

  await page.goto(`${viewer}#/design/components/avatar`);
  await expect(page.getByRole("img", { name: "Cynthia Chen" })).toHaveCount(3);
  // Five original image examples plus six status/cutout specimens.
  await expect(page.getByRole("img", { name: "Morgan Martin" })).toHaveCount(
    11,
  );
});

test("a small pane drag settles on release and Escape", async ({ page }) => {
  await page.goto(`${viewer}#/design/components/swap-workspace`);
  const playground = page.getByRole("region", { name: "3 panels playground" });
  const pane = playground.locator('[data-group="One"]');
  const header = pane.locator(".multi-swap-header");

  const dragWithinPane = async (cancel: boolean) => {
    const startTransform = await pane.evaluate(
      (element) => element.style.transform,
    );
    const box = await header.boundingBox();
    if (!box) throw new Error("Missing pane header geometry");
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2 + 20);
    if (cancel) await page.keyboard.press("Escape");
    else await page.mouse.up();
    await expect
      .poll(() => pane.evaluate((element) => element.style.transform))
      .toBe(startTransform);
    if (cancel) await page.mouse.up();
  };

  await dragWithinPane(false);
  await dragWithinPane(true);
});

test("a stale or renamed link explains itself instead of rendering blank", async ({
  page,
}) => {
  const failures: string[] = [];
  const pageErrors = watchPageErrors(page);
  for (const hash of [
    "#/design/components/renamed-away",
    "#/design/colours",
    "#/design/nope/deeper",
  ]) {
    await page.goto(`${viewer}${hash}`);
    await expect(
      page.getByRole("heading", { name: "Not in the system" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Design system" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Go to the overview" }).click();
    await expect(
      page.getByRole("heading", { name: "Buzz Design System", exact: true }),
    ).toBeVisible();
  }
  expect([...pageErrors.unexplained(), ...failures]).toEqual([]);
});

test("switch labels activate the control and busy switches preserve focus", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const control = page
    .getByRole("switch", { name: "Show agent activity" })
    .first();
  await expect(control).not.toBeChecked();
  await page
    .locator("label")
    .filter({ hasText: "Show agent activity" })
    .first()
    .click();
  await expect(control).toBeChecked();
  const busy = page.getByRole("switch", { name: "Enable busy plugin" });
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await busy.focus();
  await expect(busy).toBeFocused();
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.press(key);
    await expect(busy).toBeChecked();
    await expect(busy).toBeFocused();
  }
  await busy.click({ force: true });
  await expect(busy).toBeChecked();
});

test("avatar specimens preserve human and agent identity shapes in both modes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/avatar`);
  for (const mode of ["light", "dark"]) {
    const change = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await change.count()) await change.click();
    const agent = page.getByRole("img", { name: "Brain", exact: true });
    await expect(agent).toHaveCSS("border-radius", "0px");
    await expect(agent).toHaveCSS("mask-image", /^url\(/);
    const human = page.getByRole("img", { name: "Alex Lee", exact: true });
    expect(
      await human.evaluate(
        (element) =>
          parseFloat(getComputedStyle(element).borderTopLeftRadius) >=
          element.clientWidth / 2,
      ),
    ).toBe(true);
    for (const name of ["View Morgan profile", "View Alex profile"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const artwork = button.locator(".buzz-avatar");
      const inner = await button.evaluate((element) => ({
        width: element.clientWidth,
        height: element.clientHeight,
      }));
      await expect(artwork).toHaveCSS("width", `${inner.width}px`);
      await expect(artwork).toHaveCSS("height", `${inner.height}px`);
      if (name === "View Morgan profile") {
        await expect(artwork.locator("img")).toHaveAttribute(
          "data-loaded",
          "true",
        );
        await expect(artwork.locator("img")).toHaveCSS("opacity", "1");
      } else {
        await expect(artwork).toHaveText("A");
      }
    }
    const sizes = page.getByRole("img", { name: "Morgan Martin", exact: true });
    for (const [index, size] of [24, 32, 40].entries()) {
      await expect(sizes.nth(index)).toHaveCSS("width", `${size}px`);
    }
  }
});

test("typography shows the size ramp and renders xsmall mono details", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/typography`);
  for (const size of [12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 56, 72, 96]) {
    await expect(page.getByText(`size.${size}`, { exact: true })).toBeVisible();
  }
  const samples = page.getByText("createChannel(name, members)", {
    exact: true,
  });
  await expect(samples).toHaveCount(3);
  for (const sample of await samples.all()) {
    await expect(sample).toHaveCSS("font-size", "12px");
    await expect(sample).toHaveCSS("line-height", "16px");
    await expect(sample).toHaveCSS("font-family", /JetBrains Mono/);
  }
  await expect(
    page.getByRole("link", { name: "Typography source specification" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/squareup/design-blockinterface/blob/eff766161ba8aaee3258ca107f0d904dd542c708/blockUI/docs/type.resolution.draft.json",
  );
});

// Native label focus and reset/FormData behavior must agree in real engines.
// Detailed cancellation, controlled state and external form cases live in RTL.
test("textarea labels focus explicit IDs and preserve edits", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/textarea`);
  const textarea = page.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  await page
    .locator("label")
    .filter({ hasText: /^Description$/ })
    .click();
  await expect(textarea).toBeFocused();
  await textarea.fill("Updated summary");
  await expect(textarea).toHaveValue("Updated summary");
});

test("native form reset keeps choice appearance and submitted values together", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Notification preferences" });
  const checkbox = form.getByRole("checkbox", { name: "Include a summary" });
  const all = form.getByRole("radio", { name: "All updates" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await checkbox.click();
  await mentions.click();
  await expect(checkbox).not.toBeChecked();
  await expect(mentions).toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ notifications: "mentions" });
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(checkbox).toBeChecked();
  await expect(all).toBeChecked();
  await expect(mentions).not.toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ notifications: "all", summary: "yes" });
});

test("invalid input and textarea boundaries remain visible in both themes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/field`);
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    const controls = page.getByRole("textbox");
    await expect(controls).toHaveCount(2);
    for (const control of await controls.all()) {
      await expect(control).toHaveAttribute("aria-invalid", "true");
      await expect(control).toHaveCSS("border-top-width", "1px");
      await expect(control).toHaveCSS("border-top-style", "solid");
      await expect(control).toHaveCSS("box-shadow", "none");
      const ratio = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const components = color
            .match(/[\d.]+/g)
            ?.slice(0, 3)
            .map(Number);
          if (components?.length !== 3)
            throw new Error(`Unexpected color ${color}`);
          const linear = components.map((component) => {
            const value = component / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
          const [red = 0, green = 0, blue = 0] = linear;
          return red * 0.2126 + green * 0.7152 + blue * 0.0722;
        };
        const border = luminance(style.borderTopColor);
        const background = luminance(style.backgroundColor);
        return (
          (Math.max(border, background) + 0.05) /
          (Math.min(border, background) + 0.05)
        );
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  }
});

// These cases verify native reset against actual hidden form inputs, not only ARIA.
test("controlled choices keep the owner's unchanged values after native reset", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Controlled preferences" });
  const checkbox = form.getByRole("checkbox", { name: "Include a summary" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await checkbox.click();
  await mentions.click();
  await expect(checkbox).toBeChecked();
  await expect(mentions).toBeChecked();
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(checkbox).toBeChecked();
  await expect(mentions).toBeChecked();
  await expect(
    form.locator('input[type="radio"][value="mentions"]'),
  ).toBeChecked();
  await expect(
    form.locator('input[type="checkbox"][name="summary"]'),
  ).toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ delivery: "mentions", summary: "yes" });
});

test("radios enabled after mount remain synchronized on native reset", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Deferred preferences" });
  const all = form.getByRole("radio", { name: "All updates" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await expect(all).toBeDisabled();
  await form.getByRole("button", { name: "Enable choices" }).click();
  await mentions.click();
  await expect(mentions).toBeChecked();
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(all).toBeChecked();
  await expect(mentions).not.toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ delivery: "all" });
});

// Real CSS geometry, loading colors, and input modality cannot be proved in jsdom.
test("buttons and icon buttons share size geometry and preserve loading and disabled treatments", async ({
  page,
}) => {
  for (const kind of ["button", "icon-button"]) {
    await page.goto(`${viewer}#/design/components/${kind}`);
    const samples = page.getByRole("region", {
      name: kind === "button" ? "Button variants" : "Icon button variants",
      exact: true,
    });
    await expect(samples).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const mode of ["light", "dark"]) {
      const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
      if (await toggle.count()) await toggle.click();
      for (const [size, height, artwork] of [
        ["sm", 32, 16],
        ["md", 40, 24],
        ["lg", 52, 24],
      ] as const) {
        const button = samples.getByRole("button", {
          name: `prominent ${size}`,
          exact: true,
        });
        await expect(button).toHaveCSS("height", `${height}px`);
        await expect(button.locator("svg")).toHaveCSS("width", `${artwork}px`);
        if (kind === "icon-button") {
          await expect(button).toHaveCSS("width", `${height}px`);
          await expect
            .poll(() =>
              button.evaluate(
                (el) =>
                  parseFloat(getComputedStyle(el).borderRadius) >=
                  el.clientWidth / 2,
              ),
            )
            .toBe(true);
        } else {
          // Half the 52px large height; shorter sizes clamp to their own half-height.
          await expect(button).toHaveCSS("border-radius", "26px");
          await expect(button).toHaveCSS(
            "padding-left",
            size === "sm" ? "16px" : "24px",
          );
        }
      }
      const prominent = samples.getByRole("button", {
        name: "prominent md",
        exact: true,
      });
      // Theme switching uses real color transitions; resolve their endpoint
      // before recording the resting colors used by the loading assertion.
      const expected = await prominent.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--text-inverse)";
        probe.style.backgroundColor = "var(--affordance-prominent)";
        el.append(probe);
        const styles = getComputedStyle(probe);
        const result = {
          color: styles.color,
          background: styles.backgroundColor,
        };
        probe.remove();
        return result;
      });
      await expect(prominent).toHaveCSS("color", expected.color);
      await expect(prominent).toHaveCSS(
        "background-color",
        expected.background,
      );
      const resting = await prominent.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      }));
      await samples.getByRole("button", { name: "Show loading" }).click();
      await expect(prominent).toHaveAttribute("aria-busy", "true");
      await expect(prominent).toHaveCSS("color", resting.color);
      await expect(prominent).toHaveCSS("background-color", resting.background);
      const loading = await prominent.boundingBox();
      expect(loading?.width).toBe(resting.width);
      expect(loading?.height).toBe(resting.height);
      await samples.getByRole("button", { name: "Show disabled" }).click();
      await expect(prominent).toBeDisabled();
      for (const variant of ["ghost", "outline", "link"]) {
        const button = samples.getByRole("button", {
          name: `${variant} md`,
          exact: true,
        });
        await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      }
      await expect(
        samples.getByRole("button", { name: "outline md", exact: true }),
      ).not.toHaveCSS("box-shadow", "none");
      await samples.getByRole("button", { name: "Show enabled" }).click();
      await expect(prominent).toBeEnabled();
    }
  }
});

test("button loading keeps focus and labels stay single-line in constrained layouts", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/button`);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.focus();
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(`Shift+${tab}`);
  await page.keyboard.press(tab);
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(save).toBeFocused();
  await expect(save).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Enter");
  await expect(save).toHaveAttribute("aria-busy", "true");
  await page
    .getByRole("button", { name: "Complete saving", exact: true })
    .click();
  await expect(save).not.toHaveAttribute("aria-busy", "true");
  await save.click();
  await expect(save).toHaveCSS("outline-style", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(save.locator(".buzz-button-spinner")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page
    .getByRole("button", { name: "Complete saving", exact: true })
    .click();
  const expanded = page.getByRole("button", {
    name: "Show details",
    exact: true,
  });
  await expanded.click();
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(0, 0);
  await expect(page.locator("#button-example-details")).toBeVisible();
  await expect(expanded).toHaveCSS(
    "background-color",
    await expanded.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--affordance-subtle-pressed)";
      el.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }),
  );
  await page.evaluate(() => document.fonts.ready);
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of ["100%", "200%"]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size;
      }, fontSize);
      for (const name of [
        "Apply changes",
        "Allow notifications for this workspace",
      ]) {
        const button = page.getByRole("button", { name, exact: true });
        const label = button.locator(".buzz-button-label");
        await expect(button).toHaveCSS("flex-shrink", "0");
        await expect(label).toHaveCSS("white-space", "nowrap");
        await expect
          .poll(() =>
            label.evaluate((el) => {
              const text = [...el.childNodes].find(
                (node) =>
                  node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
              );
              if (!text) return 0;
              const range = document.createRange();
              range.selectNodeContents(text);
              return range.getClientRects().length;
            }),
          )
          .toBe(1);
        await expect
          .poll(() => button.evaluate((el) => el.scrollWidth <= el.clientWidth))
          .toBe(true);
      }
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
    }
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("font-size");
    });
  }
});

test("dialog motion retains exit presence and respects immediate interaction paths", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/dialog`);
  const trigger = page
    .getByRole("region", { name: "Single field", exact: true })
    .getByRole("button", { name: "Open dialog", exact: true });
  const popup = page.locator(".buzz-dialog");
  // Hold real CSS transitions, so intermediate presence does not depend on speed.
  await page.evaluate(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches('.buzz-dialog[data-motion="default"]')
        )
          return;
        for (const animation of event.target.getAnimations()) animation.pause();
      },
      true,
    );
  });
  const finish = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
  try {
    await trigger.click();
    await expect
      .poll(() =>
        popup.evaluate((el) =>
          el.getAnimations().some((a) => a.playState === "paused"),
        ),
      )
      .toBe(true);
    await expect(popup).toHaveCSS("transition-duration", "0.15s, 0.22s");
    await finish();
    await expect
      .poll(() => popup.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(popup).toHaveAttribute("data-ending-style", "");
    await expect
      .poll(() =>
        popup.evaluate((el) =>
          el.getAnimations().some((a) => a.playState === "paused"),
        ),
      )
      .toBe(true);
    await expect(popup).toHaveCSS("transition-duration", "0.12s");
    await finish();
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Escape can interrupt a pointer-opened entrance without waiting for motion.
    await trigger.click();
    await expect
      .poll(() =>
        popup.evaluate((el) =>
          el.getAnimations().some((a) => a.playState === "paused"),
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Use real keyboard navigation to activate the host's modality owner.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await trigger.press("Enter");
    await expect(popup).toHaveCSS("transition-duration", "0s");
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(popup).toHaveCSS("transition-duration", "0s");
    await expect(popup).toHaveCSS("opacity", "1");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(popup).toHaveCount(0);
  } finally {
    await finish();
  }
});

// Real engines own :focus-visible, input modality and portal focus transfer.
test("menu items retain keyboard navigation with hidden focus outlines in both modes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/menu`);
  const trigger = page.getByRole("button", {
    name: "More actions",
    exact: true,
  });
  const action = page.getByRole("menuitem", {
    name: "Mark all as read",
    exact: true,
  });
  const checkbox = page.getByRole("menuitemcheckbox", {
    name: "Notifications",
  });
  const submenu = page.getByRole("menuitem", { name: "Sort", exact: true });
  const recent = page.getByRole("menuitemradio", { name: "Recent" });
  const alpha = page.getByRole("menuitemradio", { name: "A–Z" });
  // Every position and grouped choice uses the shared full-round token.
  const expectRounded = async (item: Locator) => {
    const radius = await item.evaluate((element) => {
      // The shared pill token is rem-based; computed corner values are pixels.
      const rem = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--radius-pill"),
      );
      const rootSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      return `${rem * rootSize}px`;
    });
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]) {
      await expect(item).toHaveCSS(`border-${corner}-radius`, radius);
    }
  };
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    await trigger.click();
    await expect(page.getByRole("menu")).toHaveCSS("transform", "none");
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const item of [action, checkbox, submenu]) await expectRounded(item);
    }
    await page.mouse.move(0, 0);
    await action.hover();
    // Programmatic focus following a pointer open must stay quiet too.
    await action.focus();
    await expect(action).toBeFocused();
    await expect(action).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.keyboard.press(tab);
    await page.keyboard.press(`Shift+${tab}`);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("ArrowDown");
    for (const item of [action, checkbox, submenu]) {
      await expect(item).toBeFocused();
      await expect(item).toHaveCSS("outline-style", "none");
      if (item !== submenu) await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("ArrowRight");
    await expect(recent).toBeFocused();
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const item of [recent, alpha]) await expectRounded(item);
    }
    await expect(recent).toHaveCSS("outline-style", "none");
    await page.keyboard.press("ArrowDown");
    await expect(alpha).toBeFocused();
    await expect(alpha).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");
    await expect(submenu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Returning to pointer input must remove the ring even after keyboard use.
    await trigger.click();
    await submenu.hover();
    await expect(recent).toBeVisible();
    await expect(page.getByRole("menu").last()).toHaveCSS("transform", "none");
    await recent.hover();
    await recent.focus();
    await expect(recent).toBeFocused();
    await expect(recent).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
});

// Geometry and hit testing cannot be established by a DOM emulator.
test("shared menus stay reachable near viewport edges and above a dialog", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/menu`);
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    const context = page.getByRole("button", { name: "Context actions" });
    // Put the real trigger at the collision boundary, without replacing menu behavior.
    await context.evaluate((element) => {
      Object.assign(element.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        zIndex: "1",
      });
    });
    const contextBounds = await context.boundingBox();
    if (!contextBounds)
      throw new Error("Context trigger has no visible bounds");
    // Stay near the viewport edge, inside the pill rather than its cut-out corner.
    await context.click({
      button: "right",
      position: { x: contextBounds.width - 4, y: contextBounds.height / 2 },
    });
    const popup = page.getByRole("menu");
    await expect(popup).toBeVisible();
    await expect(popup).toHaveCSS("transform", "none");
    const box = await popup.boundingBox();
    if (!box) throw new Error("Context menu has no visible bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    await page
      .getByRole("menuitem", { name: "Copy link", exact: true })
      .click();
    await expect(popup).toHaveCount(0);
    const trigger = page.getByRole("button", {
      name: "More actions",
      exact: true,
    });
    await trigger.evaluate((element) => {
      Object.assign(element.style, {
        position: "fixed",
        right: "0",
        top: "0",
        zIndex: "1",
      });
    });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: "Mark all as read", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: "Sort", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const nested = page.getByRole("menu", { name: "Sort", exact: true });
    await expect(nested).toBeVisible();
    await expect(nested).toHaveCSS("transform", "none");
    const nestedBox = await nested.boundingBox();
    if (!nestedBox) throw new Error("Submenu has no visible bounds");
    expect(nestedBox.x).toBeGreaterThanOrEqual(0);
    expect(nestedBox.y).toBeGreaterThanOrEqual(0);
    expect(nestedBox.x + nestedBox.width).toBeLessThanOrEqual(width);
    expect(nestedBox.y + nestedBox.height).toBeLessThanOrEqual(700);
    const choice = page.getByRole("menuitemradio", { name: "A–Z" });
    await choice.click();
    await expect(choice).toBeChecked();
    // Base UI choices stay open by default; dismiss each level explicitly.
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menuitem", { name: "Sort", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Open menu dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu composition" });
  const trigger = dialog.getByRole("button", { name: "More actions" });
  await trigger.click();
  const action = page.getByRole("menuitem", {
    name: "Mark all as read",
    exact: true,
  });
  await expect(action).toBeVisible();
  await action.click(); // Playwright hit testing rejects an obscured portal.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
});

// Real iframe sizing, theme propagation, media decoding and built asset paths
// require a browser; the specimen interactions only mutate local sample state.
test("built Messages gallery renders isolated product states and follows viewer theme and width", async ({
  page,
}) => {
  const failures: string[] = [];
  const sockets: string[] = [];
  const pageErrors = watchPageErrors(page);
  page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(`${viewer}#/design/messages`);
  const gallery = page.frameLocator('iframe[title="Message types and states"]');
  await expect(gallery.locator(".message-gallery-example")).toHaveCount(33);
  await expect(
    gallery.getByRole("heading", { name: "Member removed", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.locator("iframe").evaluate((el) => el.clientHeight))
    .toBeLessThanOrEqual(900);
  await gallery
    .getByRole("button", { name: "Delivery states", exact: true })
    .click();
  const failed = gallery.getByRole("region", { name: "Failed", exact: true });
  await expect(failed.getByRole("status")).toHaveText(
    "Couldn’t send this message.",
  );
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failed.getByRole("status")).toHaveCount(0);
  await gallery.getByRole("button", { name: "Reset examples" }).click();
  await expect(failed.getByRole("status")).toHaveText(
    "Couldn’t send this message.",
  );
  await gallery
    .getByRole("button", { name: "Conversation context", exact: true })
    .click();
  await gallery.getByRole("button", { name: "View thread: 4 replies" }).click();
  await expect(
    gallery.getByRole("region", { name: "Sample thread replies" }),
  ).toBeVisible();
  await gallery.getByRole("button", { name: "Close replies" }).click();
  await expect(
    gallery.getByRole("region", { name: "Sample thread replies" }),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    await expect(gallery.locator("html")).toHaveAttribute(
      "data-color-mode",
      mode,
    );
    await gallery
      .getByRole("button", { name: "Attachments", exact: true })
      .click();
    const video = gallery
      .getByRole("region", { name: "Video attachment", exact: true })
      .locator("video");
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          gallery
            .locator("body")
            .evaluate((el) => el.scrollWidth <= window.innerWidth),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
    }
  }
  await gallery
    .getByRole("button", { name: "Content and identity", exact: true })
    .click();
  await gallery.getByRole("button", { name: "Narrow preview" }).click();
  await expect
    .poll(() =>
      gallery
        .locator(".message-gallery-examples")
        .evaluate((el) => el.clientWidth),
    )
    .toBeLessThanOrEqual(390);
  await expect(
    gallery.getByRole("button", { name: "View Sam Rivera profile" }),
  ).toBeVisible();
  await expect(
    gallery.getByRole("img", { name: ":landscape:", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(gallery.locator(".message-gallery-example")).toHaveCount(33);
  expect([...pageErrors.unexplained(), ...failures]).toEqual([]);
  expect(sockets).toEqual([]);
});

// Real layout/focus coverage: a DOM emulator cannot prove portal stacking or scroll reachability.
test("toast recovery stays reachable across themes, sizes, keyboard scrolling and modals", async ({
  page,
}, testInfo) => {
  await page.goto(`${viewer}#/design/components/toast`);
  const region = page.getByRole("region", { name: "App notifications" });
  const recovery = page.getByRole("dialog", {
    name: "Changes weren’t saved",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    const theme = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await theme.count()) await theme.click();
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page
        .getByRole("button", { name: "Show recovery", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(recovery).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Show recovery", exact: true }),
      ).toBeFocused();
      const box = await region.boundingBox();
      if (!box) throw new Error("Toast viewport has no geometry");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThan(844 - 160);
      await page.keyboard.press("F6");
      await expect(region).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(recovery).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(recovery).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Retry saving", exact: true }),
      ).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`toast-${mode}-${width}.png`),
      });
      await page.keyboard.press("Enter");
      await expect(recovery).toHaveCount(0);
    }
  }

  await page.setViewportSize({ width: 480, height: 400 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--type-scale", "1.2"),
  );
  await page
    .getByRole("button", { name: "Show recovery", exact: true })
    .click();
  await page.keyboard.press("F6");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const shortRetry = page.getByRole("button", {
    name: "Retry saving",
    exact: true,
  });
  await expect(shortRetry).toBeFocused();
  await shortRetry.click();
  await expect(recovery).toHaveCount(0);
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--type-scale"),
  );
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Show recovery stack" }).click();
  await expect(region.getByRole("dialog")).toHaveCount(6);
  await expect(region.getByRole("dialog").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await page.keyboard.press("F6");
  // Newest first, with no inert overflow entries: reach the oldest through real Tab scrolling.
  for (let id = 6; id >= 1; id--) {
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("dialog", { name: `Recovery ${id}`, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const resolve = page.getByRole("button", {
      name: `Resolve ${id}`,
      exact: true,
    });
    await expect(resolve).toBeFocused();
    const actionBox = await resolve.boundingBox();
    const viewportBox = await region.boundingBox();
    if (!actionBox || !viewportBox)
      throw new Error("Recovery action has no geometry");
    expect(actionBox.y).toBeGreaterThanOrEqual(viewportBox.y);
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(
      viewportBox.y + viewportBox.height,
    );
  }
  expect(await region.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Recovery 1", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Open example dialog" }).click();
  const modal = page.getByRole("dialog", {
    name: "Example dialog",
    exact: true,
  });
  await expect(modal).toBeVisible();
  await expect(region).toHaveCount(1); // Base UI keeps live regions announced during modals.
  await page.keyboard.press("F6");
  await expect
    .poll(() =>
      modal.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(region.getByRole("dialog")).toHaveCount(5);
  await page
    .getByRole("navigation", { name: "Design system" })
    .getByRole("link", { name: "Button", exact: true })
    .click();
  await expect(region).toHaveCount(0); // Leaving the owner clears the stack.
});

// Cross-document fullscreen placement and native focus restoration require a browser.
test("Messages gallery fullscreen stays reachable and returns focus to its trigger", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/messages`);
  const gallery = page.frameLocator('iframe[title="Message types and states"]');
  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const category of ["All messages", "Attachments"]) {
      await gallery
        .getByRole("button", { name: category, exact: true })
        .click();
      const trigger = gallery
        .getByRole("button", { name: "Open video fullscreen", exact: true })
        .first();
      await trigger.click();
      const dialog = gallery.getByRole("dialog", {
        name: "Video attachment",
        exact: true,
      });
      const close = dialog.getByRole("button", {
        name: "Close fullscreen viewer",
        exact: true,
      });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await expect(close).toBeInViewport({ ratio: 1 });
      await expect(close).toBeFocused();
      await expect(dialog.locator("video")).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() =>
          dialog
            .locator("video")
            .evaluate(
              (video) =>
                video instanceof HTMLVideoElement &&
                video.readyState >= 2 &&
                video.videoWidth > 0 &&
                video.currentTime > 0,
            ),
        )
        .toBe(true);
      await close.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
});

// Real engines own transition presence, filtering, portal dismissal, and focus.
test("form choice popups settle, retain exit presence, and respect immediate motion", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/forms`);
  // Select retains a hidden portal to measure labels; Combobox unmounts it.
  // Both must remove the active surface after its exit completes.
  const popup = page.locator(
    ".buzz-select-positioner:not([hidden]) .buzz-select-popup",
  );
  await page.evaluate(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(".buzz-select-popup")
        )
          return;
        for (const animation of event.target.getAnimations()) animation.pause();
      },
      true,
    );
  });
  const finish = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
  const paused = () =>
    expect
      .poll(() =>
        popup.evaluate((el) =>
          el
            .getAnimations()
            .some((animation) => animation.playState === "paused"),
        ),
      )
      .toBe(true);
  try {
    for (const name of ["Destination", "Searchable destination"]) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const field = page.getByRole("combobox", { name, exact: true }).first();
      await field.click();
      await paused();
      await expect(popup).toHaveCSS(
        "transition-duration",
        "0.15s, 0.15s, 0.15s",
      );
      const frames = await popup.evaluate((el) =>
        el
          .getAnimations()
          .flatMap((animation) =>
            (animation.effect as KeyframeEffect).getKeyframes(),
          ),
      );
      expect(frames.some((frame) => frame.filter === "blur(4px)")).toBe(true);
      expect(
        frames.some(
          (frame) =>
            typeof frame.transform === "string" &&
            /translateY\(-?4px\)/.test(frame.transform),
        ),
      ).toBe(true);
      await finish();
      await expect(popup).toHaveCSS("filter", "blur(0px)");
      await expect(popup).toHaveCSS("opacity", "1");
      await page.getByRole("option", { name: /^Product team/ }).click();
      await expect(popup).toHaveAttribute("data-ending-style", "");
      await paused();
      await expect(popup).toHaveCSS("transition-duration", "0.12s");
      await finish();
      await expect(popup).toHaveCount(0);
      await expect(field).toBeFocused();

      await page.keyboard.press("Tab");
      await field.focus();
      await field.press("ArrowDown");
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transition-duration", "0s");
      await expect(popup).toHaveCSS("filter", "none");
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await field.click();
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transition-duration", "0s");
      await expect(popup).toHaveCSS("filter", "none");
      await expect(popup).toHaveCSS("transform", "none");
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
  } finally {
    await finish();
  }
});

// Native portal focus and dismissal cannot be established by a DOM emulator.
test("popovers return focus and nested popovers close before their dialog", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/popover`);
  const trigger = page.getByRole("button", {
    name: "Edit workspace name",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Tab");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", {
    name: "Edit workspace",
    exact: true,
  });
  const input = popup.getByRole("textbox", { name: "Workspace name" });
  await expect(input).toBeFocused();
  await expect(popup).toHaveCSS("transition-duration", "0s");
  await input.fill("Research studio");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("status")).toHaveText("Workspace: Design studio");
  await trigger.click();
  await expect(input).toHaveValue("Design studio");
  await input.fill("Research studio");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Workspace: Research studio",
  );
  const activityTrigger = page.getByRole("button", {
    name: "Recent activity",
    exact: true,
  });
  await activityTrigger.hover();
  const activity = page.getByRole("dialog", {
    name: "Recent activity",
    exact: true,
  });
  await expect(activity).toBeVisible();
  await activity.hover();
  await expect(activity).toBeVisible();
  await activity.getByRole("button", { name: /Alex Morgan/ }).click();
  await expect(activity).toHaveCount(0);
  await page.getByRole("button", { name: "Open popover dialog" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Workspace details",
    exact: true,
  });
  const nestedTrigger = dialog.getByRole("button", {
    name: "View access details",
  });
  await nestedTrigger.click();
  const nested = page.getByRole("dialog", { name: "Invite only", exact: true });
  await expect(nested.getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nested).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(nestedTrigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// Popup collision geometry, scrolling and text scaling need a layout engine.
test("popover placements and rich choices fit narrow screens and enlarged text", async ({
  page,
}) => {
  for (const mode of ["light", "dark"]) {
    await page.goto(`${viewer}#/design/components/popover`);
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    await page.setViewportSize({ width: 390, height: 850 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const side of ["top", "right", "bottom", "left"]) {
      await page.getByRole("button", { name: side, exact: true }).click();
      const popup = page.getByRole("dialog", {
        name: `Anchored ${side}`,
        exact: true,
      });
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transform", "none");
      const box = await popup.boundingBox();
      if (!box) throw new Error("Popover has no visible bounds");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(850);
      await expect
        .poll(() => popup.evaluate((e) => e.scrollWidth <= e.clientWidth))
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
    await page.goto(`${viewer}#/design/components/menu`);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page
      .getByRole("button", { name: "Choose an agent", exact: true })
      .click();
    const menu = page.getByRole("menu", {
      name: "Choose an agent",
      exact: true,
    });
    await expect(menu).toHaveCSS("transform", "none");
    await expect
      .poll(() => menu.evaluate((e) => e.scrollWidth <= e.clientWidth))
      .toBe(true);
    const disabled = page.getByRole("menuitemradio", {
      name: "Archive assistant Unavailable on this connection",
    });
    await expect(disabled.locator(".buzz-choice-row-label")).toHaveCSS(
      "color",
      await disabled.evaluate((e) => getComputedStyle(e).color),
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Choose workspace", exact: true })
      .click();
    const list = page.getByRole("menu", {
      name: "Choose workspace",
      exact: true,
    });
    await expect(list).toHaveCSS("transform", "none");
    await expect
      .poll(() => list.evaluate((e) => e.scrollHeight > e.clientHeight))
      .toBe(true);
    await page.keyboard.press("End");
    const last = page.getByRole("menuitemradio", {
      name: "Workspace 24",
      exact: true,
    });
    await expect(last).toBeFocused();
    const listBox = await list.boundingBox();
    const rowBox = await last.boundingBox();
    if (!listBox || !rowBox)
      throw new Error("Menu or last row has no visible bounds");
    expect(rowBox.y).toBeGreaterThanOrEqual(listBox.y);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
      listBox.y + listBox.height,
    );
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
  }
});

// Reduced-motion preference must suppress popup animation in the browser.
test("popover reduced motion and outside dismissal remain immediate", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${viewer}#/design/components/popover`);
  await page.getByRole("button", { name: "Open popover", exact: true }).click();
  const popup = page.getByRole("dialog", {
    name: "Workspace access",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(popup).toHaveCSS("transition-duration", "0s");
  await page.getByRole("heading", { name: "Popover", exact: true }).click();
  await expect(popup).toHaveCount(0);
});

// Hold real CSS transitions to inspect entry/exit frames and Base UI presence.
test("menus and popovers reuse the dropdown unblur and placement offset", async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(".buzz-menu-popup, .buzz-popover-popup")
        )
          return;
        for (const animation of event.target.getAnimations()) animation.pause();
      },
      true,
    );
  });
  const finish = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
  for (const example of [
    { page: "menu", trigger: "Open menu", selector: ".buzz-menu-popup" },
    { page: "popover", trigger: "top", selector: ".buzz-popover-popup" },
    { page: "popover", trigger: "right", selector: ".buzz-popover-popup" },
  ]) {
    await page.goto(`${viewer}#/design/components/${example.page}`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const trigger = page.getByRole("button", {
      name: example.trigger,
      exact: true,
    });
    const popup = page.locator(example.selector);
    const paused = () =>
      expect
        .poll(() =>
          popup.evaluate((el) =>
            el
              .getAnimations()
              .some((animation) => animation.playState === "paused"),
          ),
        )
        .toBe(true);
    try {
      await trigger.click();
      await paused();
      await expect(popup).toHaveCSS(
        "transition-duration",
        "0.075s, 0.075s, 0.075s",
      );
      const side = await popup.getAttribute("data-side");
      const offset =
        side === "top"
          ? "translateY(2px)"
          : side === "right"
            ? "translateX(-2px)"
            : side === "left"
              ? "translateX(2px)"
              : "translateY(-2px)";
      const frames = await popup.evaluate((el) =>
        el
          .getAnimations()
          .flatMap((animation) =>
            (animation.effect as KeyframeEffect).getKeyframes(),
          ),
      );
      expect(frames.some((frame) => frame.filter === "blur(2px)")).toBe(true);
      expect(frames.some((frame) => frame.transform === offset)).toBe(true);
      await finish();
      await expect(popup).toHaveCSS("filter", "blur(0px)");
      await expect(popup).toHaveCSS("transform", "none");
      await trigger.click();
      await expect(popup).toHaveAttribute("data-ending-style", "");
      await paused();
      await expect(popup).toHaveCSS("transition-duration", "0.06s");
      await finish();
      await expect(popup).toHaveCount(0);

      await page.keyboard.press("Tab");
      await trigger.focus();
      await trigger.press("Enter");
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transition-duration", "0s");
      await expect(popup).toHaveCSS("filter", "none");
      await expect(popup).toHaveCSS("transform", "none");
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await trigger.click();
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transition-duration", "0s");
      await expect(popup).toHaveCSS("filter", "none");
      await expect(popup).toHaveCSS("transform", "none");
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    } finally {
      await finish();
    }
  }
});
