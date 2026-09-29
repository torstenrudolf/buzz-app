import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser geometry is the contract: jsdom cannot show a rounded overflow clip.
// Keep the real channel hover, rows and popup; only the upstream relay is modeled.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const multiple of [false, true]) {
  test.describe(multiple ? "multiple rows" : "single row", () => {
    test.use({ threadUnreadMentions: multiple });

    test("channel activity corners preserve the popup inset", async ({
      page,
      app,
    }, testInfo) => {
      await open(page, app);
      const sidebar = page.getByRole("complementary", {
        name: "Channel sidebar",
        includeHidden: true,
      });
      const showNavigation = page.getByRole("button", {
        name: "Show navigation",
        exact: true,
      });
      const alpha = sidebar.locator('button[data-channel-id="alpha"]');
      await expect(
        alpha.getByRole("img", { name: /unread threads?/ }),
      ).toBeVisible();
      const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
      const rows = popup.getByRole("button", {
        name: /Open unread thread from/,
      });
      const settleNavigation = async () => {
        await expect(
          page.locator("[data-shell-sidebar-toggle]"),
        ).toHaveAccessibleName(
          page.viewportSize().width <= 650
            ? /^(Show|Hide) navigation$/
            : /^(Show|Hide) Channel sidebar$/,
        );
      };
      // Discover the narrowest viewport that keeps the trigger hoverable, so
      // the geometry matrix follows the responsive drawer breakpoint wherever
      // it moves, instead of hardcoding a width just above it.
      const wide = 1440;
      let narrow = 320;
      for (let high = wide; narrow < high; ) {
        const mid = (narrow + high) >> 1;
        await page.setViewportSize({ width: mid, height: 950 });
        await settleNavigation();
        if (
          await alpha.evaluate((element) => element.getClientRects().length > 0)
        )
          high = mid;
        else narrow = mid + 1;
      }
      const openPopup = async () => {
        if (await showNavigation.isVisible()) await showNavigation.click();
        await expect(alpha).toBeVisible();
        await alpha.hover();
        await expect(rows).toHaveCount(multiple ? 2 : 1);
        await rows.first().hover();
        await expect(popup).not.toHaveAttribute("data-starting-style", "");
      };
      const closePopup = async () => {
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
        await expect(popup).toHaveCount(0);
      };
      for (const mode of ["light", "dark"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.colorMode = mode;
        }, mode);
        // Include the enlarged text and an offset trigger position without
        // changing the popup's content. The second width hugs the discovered
        // hoverable boundary: beyond it the sidebar folds into the navigation
        // drawer and the channel trigger stops being hoverable.
        for (const width of [wide, narrow]) {
          await page.setViewportSize({ width, height: 950 });
          await settleNavigation();
          const enlarged = width === narrow;
          await page.evaluate((enlarged) => {
            document.documentElement.style.setProperty(
              "--type-scale",
              enlarged ? "2" : "1",
            );
          }, enlarged);
          // Resize only while closed: moving a hover popup away from the pointer
          // legitimately dismisses it, racing the next row interaction.
          await openPopup();
          await expect
            .poll(
              () =>
                popup.evaluate((element) => {
                  const style = getComputedStyle(element);
                  const outerRadius = parseFloat(style.borderTopLeftRadius);
                  const expected =
                    outerRadius -
                    parseFloat(style.borderTopWidth) -
                    parseFloat(style.paddingTop);
                  return Array.from(
                    element.querySelectorAll(".navigation-item"),
                  ).every((row) => {
                    const inner = getComputedStyle(row);
                    return [
                      inner.borderTopLeftRadius,
                      inner.borderTopRightRadius,
                      inner.borderBottomLeftRadius,
                      inner.borderBottomRightRadius,
                    ].every(
                      (radius) => Math.abs(parseFloat(radius) - expected) < 0.1,
                    );
                  });
                }),
              { message: "each row follows the popup's inset corner curve" },
            )
            .toBe(true);
          await expect(rows.last()).toBeVisible();
          await rows.last().hover();
          await expect(rows.last().locator("..")).toHaveCSS(
            "border-top-width",
            "0px",
          );
          await popup.screenshot({
            path: testInfo.outputPath(`hover-corners-${mode}-${width}.png`),
          });
          await closePopup();
        }
      }
      // A short viewport makes this same real popover scroll, without replacing
      // its rows or disabling clipping to make the corner assertion pass.
      await page.setViewportSize({ width: narrow, height: 240 });
      await openPopup();
      if (multiple) {
        await expect
          .poll(() =>
            popup.evaluate(
              (element) => element.scrollHeight > element.clientHeight,
            ),
          )
          .toBe(true);
      }
      await rows.last().scrollIntoViewIfNeeded();
      await rows.last().hover();
      await expect(rows.last()).toBeInViewport();
      await popup.screenshot({
        path: testInfo.outputPath("hover-corners-scrolled.png"),
      });
      await rows.last().focus();
      await expect(rows.last()).toBeFocused();
      await rows.last().press("Enter");
      await expect(
        page.getByRole("complementary", { name: "Thread", exact: true }),
      ).toBeVisible();
      await expect(popup).toHaveCount(0);
    });
  });
}
