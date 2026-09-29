import { expect, test } from "./source-fixture.mjs";

// Sample actual browser paint, not just shape attributes or bounding boxes.
async function pixels(page, locator, inset = 0) {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  // Browser crops round outward to device pixels. Keep the fractional artwork
  // origin rather than treating that rounded image as the avatar's own bounds.
  const margin = Math.max(0, -inset);
  const clip = {
    x: Math.floor(bounds.x - margin),
    y: Math.floor(bounds.y - margin),
    width:
      Math.ceil(bounds.x + bounds.width + margin) -
      Math.floor(bounds.x - margin),
    height:
      Math.ceil(bounds.y + bounds.height + margin) -
      Math.floor(bounds.y - margin),
  };
  const png = await page.screenshot({ clip, scale: "css" });
  return page.evaluate(
    async ({ base64, inset, bounds, clip }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const at = (fraction, vertical = fraction) => [
        ...context.getImageData(
          Math.floor(
            bounds.x - clip.x + inset + (bounds.width - 2 * inset) * fraction,
          ),
          Math.floor(
            bounds.y - clip.y + inset + (bounds.height - 2 * inset) * vertical,
          ),
          1,
          1,
        ).data,
      ];
      // One pixel inside the inset exposes a missing inner clip; its exact
      // outermost corner can still be clipped by the parent's mask alone.
      return {
        corner: at(inset ? 0.05 : 0),
        shoulder: at(0.1),
        center: at(0.5),
        top: at(0.5, 0),
      };
    },
    { base64: png.toString("base64"), inset, bounds, clip },
  );
}

test("representative avatars preserve identity, inset artwork and profile controls", async ({
  page,
  browserName,
}) => {
  await page.goto("/tests/fixtures/avatar-shapes.html");
  // Group wrappers and their shared artwork both carry the shape; count each
  // displayed identity once, while retaining the inset paint assertions.
  const avatars = page.locator(
    "[data-avatar-shape]:not([data-avatar-shape] [data-avatar-shape])",
  );
  await expect(avatars).toHaveCount(15);
  for (const image of await avatars.locator("img").all()) {
    await expect
      .poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0))
      .toBe(true);
    await expect(image).toHaveCSS("opacity", "1");
  }
  const system = page.getByRole("region", { name: "System avatars" });
  const insetAvatars = page.locator(
    "button[aria-label^='View thread:'] [data-avatar-shape]:not([data-avatar-shape] [data-avatar-shape]), [data-membership-row] [data-avatar-shape]:not([data-avatar-shape] [data-avatar-shape])",
  );
  await expect(insetAvatars).toHaveCount(4);
  async function expectInsetArtwork() {
    for (const avatar of await insetAvatars.all()) {
      const shape = await avatar.getAttribute("data-avatar-shape");
      const membership = await avatar.evaluate(
        (el) => !!el.closest("[data-membership-row]"),
      );
      const outer = await avatar.boundingBox();
      const inner = await avatar.locator(".buzz-avatar").boundingBox();
      const inset = inner.x - outer.x;
      expect(
        inset,
        "overlap ring leaves an inset around artwork",
      ).toBeGreaterThan(0);
      // Sample inside the overlap ring: an outer mask alone leaves the
      // actual image/fallback corners square even when its CSS says squircle.
      const paint = await pixels(page, avatar, inset);
      const surface = await avatar.evaluate((el, membership) => {
        const style = getComputedStyle(el);
        const rgb = (membership ? style.borderTopColor : style.backgroundColor)
          .match(/\d+/g)
          .map(Number);
        return [...rgb.slice(0, 3), 255];
      }, membership);
      const artwork = [255, 0, 255, 255];
      // Edge pixels are antialiased at these tiny sizes. Compare whether the
      // pixel is mostly background or artwork, rather than demanding zero
      // coverage at the boundary (or confusing photo texture with clipping).
      const distance = (pixel, color) =>
        pixel.reduce((sum, value, i) => sum + (value - color[i]) ** 2, 0);
      expect(
        distance(paint.corner, surface),
        `${shape}: inset corner is clipped`,
      ).toBeLessThan(distance(paint.corner, artwork));
      expect(paint.center, "inset picture is painted").toEqual(artwork);
      if (shape === "squircle")
        // At 20px the shoulder itself can be mostly antialiasing. It must
        // still paint beyond the clipped corner, not promise full coverage.
        expect(
          distance(paint.shoulder, artwork),
          "inset squircle retains its shoulder",
        ).toBeLessThan(distance(paint.corner, artwork));
      else
        expect(
          distance(paint.shoulder, surface),
          "inset human avatar stays circular",
        ).toBeLessThan(distance(paint.shoulder, artwork));
    }
  }
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    // The same scalable mask owns all sizes. Keep photo + fallback in the
    // shared component and the legacy adapter, not size × viewport recipes.
    await expectInsetArtwork();
    const representatives = system
      .locator(
        '.buzz-avatar[data-size="default"], .buzz-avatar[data-size="small"]',
      )
      .or(
        page
          .getByRole("region", { name: "Legacy avatars" })
          .locator("[data-avatar-shape]"),
      );
    for (const avatar of await representatives.all()) {
      const shape = await avatar.getAttribute("data-avatar-shape");
      const paint = await pixels(page, avatar);
      expect(paint.center, `${mode}/${shape}: artwork is painted`).not.toEqual(
        paint.corner,
      );
      if (shape === "squircle")
        expect(paint.shoulder, "squircle extends beyond a circle").not.toEqual(
          paint.corner,
        );
      else
        expect(paint.shoulder, "human corner stays circular").toEqual(
          paint.corner,
        );
    }
  }
  await page.getByRole("checkbox", { name: "Show pictures" }).uncheck();
  await expect(insetAvatars.locator("img")).toHaveCount(0);
  // Fallback identity remains readable in both inset consumers; fallback
  // shape paint is covered by the representative shared avatars above.
  for (const avatar of await insetAvatars.all()) {
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveText(/^[AH]$/);
  }
  await page.getByRole("checkbox", { name: "Show pictures" }).check();
  const button = page.getByRole("button", { name: "View Agent profile" });
  await button.hover();
  await button.click();
  await expect(page.getByRole("status")).toHaveText("Profile opened");
  await expect(button).toHaveCSS("outline-style", "none");
  await page.getByRole("button", { name: "Before avatars" }).focus();
  // Safari on macOS uses Option-Tab to include all controls, like the other focus journeys.
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(button).toBeFocused();
  await expect(button).toHaveCSS("outline-style", "solid");
  await expect(button).toHaveCSS("mask-image", "none");
  await expect(button).toHaveCSS("clip-path", "none");
  await expect(button).toHaveCSS("overflow", "visible");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Profile opened");
  // Shape clips artwork, never the agent-first thread-summary control (#342).
  const thread = page.getByRole("button", { name: "View thread: 2 replies" });
  await expect(thread).toHaveCSS("mask-image", "none");
  await expect(thread).toHaveCSS("clip-path", "none");
  await expect(
    thread.locator('[data-avatar-shape="squircle"]').first(),
  ).toHaveCSS("mask-image", /^url\(/);
  await thread.focus();
  await expect(thread).toHaveCSS("outline-style", "solid");
  const ringInset = await thread.evaluate((element) => {
    const style = getComputedStyle(element);
    return -(
      parseFloat(style.outlineOffset) +
      parseFloat(style.outlineWidth) / 2
    );
  });
  expect(ringInset).toBeLessThan(0);
  await button.focus();
  const beforeFocus = await pixels(page, thread, ringInset);
  // Real keyboard modality was established above; do not couple this paint
  // assertion to the message row's intervening author/action tab stops.
  await thread.focus();
  await expect(thread).toBeFocused();
  await expect(thread).toHaveCSS("outline-style", "solid");
  const focused = await pixels(page, thread, ringInset);
  expect(
    focused.top,
    "thread keyboard ring paints outside the control",
  ).not.toEqual(beforeFocus.top);
});
