import { test, expect } from "./fixture.mjs";

// A visible badge requires confirmed presence, not just local Online intent.
test.use({ productionBroker: true });

// Real CSS paint and shell geometry require a browser, not DOM emulation.
test("profile avatar cutout shows the shell through hover, press and open menu", async ({
  page,
  app,
  browserName,
}) => {
  await page.goto(app.origin);
  const control = page.getByRole("button", {
    name: "Your profile",
    exact: true,
    includeHidden: true,
  });
  await expect(control.locator(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "online",
  );
  await control.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("main")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 844 });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    // Return to an ordinary pointer state after the preceding keyboard check.
    await page.mouse.click(400, 20);
    await page.mouse.move(0, 0);
    const bounds = await control.boundingBox();
    const clip = {
      x: bounds.x - 4,
      y: bounds.y - 4,
      width: bounds.width + 8,
      height: bounds.height + 8,
    };
    await control.evaluate((el) => {
      el.style.visibility = "hidden";
    });
    let background;
    try {
      background = await page.screenshot({ clip });
    } finally {
      await control.evaluate((el) => {
        el.style.removeProperty("visibility");
      });
    }
    const sample = (png) =>
      page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
        return {
          // The screenshot includes 4px outside the 28px control. Its gap
          // is at avatar-local (20,20); the other samples detect a focus ring.
          gap: at(24, 24),
          left: at(1, 18),
          top: at(18, 1),
          right: at(34, 18),
        };
      }, png.toString("base64"));
    const expected = await sample(background);
    for (const state of ["rest", "hover", "pressed", "open"]) {
      if (state === "hover") await control.hover();
      if (state === "pressed") await page.mouse.down();
      if (state === "open") {
        await expect(control).toHaveAttribute("aria-expanded", "true");
      }
      try {
        await expect(control).toHaveCSS("outline-style", "none");
        await expect(control).toHaveCSS("border-width", "0px");
        await expect(control).toHaveCSS("box-shadow", "none");
        const screenshot = await page.screenshot({ clip });
        expect
          .soft(
            await sample(screenshot),
            `${mode}/${state}: clear cutout and no pointer ring`,
          )
          .toEqual(expected);
      } finally {
        if (state === "pressed") await page.mouse.up();
      }
    }
    await page.keyboard.press("Escape");
    await expect(control).toBeFocused();
    const tab =
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab";
    await page.keyboard.press(`Shift+${tab}`);
    await page.keyboard.press(tab);
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-style", "solid");
    await expect(control).toHaveCSS("outline-width", "2px");
    const focused = await sample(await page.screenshot({ clip }));
    for (const side of ["left", "top", "right"])
      expect(
        focused[side],
        `${mode}: keyboard ring paints at ${side}`,
      ).not.toEqual(expected[side]);
    await control.press("Enter");
    await expect(control).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(control).toHaveCSS("mask-image", "none");
    await page.mouse.click(400, 20);
    await expect(control).not.toBeFocused();
    await expect(control).toHaveCSS("outline-style", "none");
  }
});
