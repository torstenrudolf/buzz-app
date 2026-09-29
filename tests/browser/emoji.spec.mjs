import { expectPhosphor } from "./phosphor.mjs";
import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchPageErrors } from "./page-errors.mjs";

test("community picker uses keyboard, proxy thumbnails, event-local history and scoped send/reply tags", async ({
  browserName,
  page,
}) => {
  // Parallel fixtures must not invalidate each other’s optimized lazy imports.
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-emoji-vite-"));
  let server;
  try {
    server = await createServer({
      cacheDir,
      root: fileURLToPath(new URL("../../", import.meta.url)),
      configFile: false,
      envFile: false,
      plugins: [react()],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    const errors = watchPageErrors(page);
    await page.route("**/emoji-media/**", async (route) => {
      if (route.request().url().includes("broken.png"))
        return route.fulfill({ status: 404, body: "missing" });
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
      });
    });
    await server.listen();
    // The host selection, not the operating system, chooses the widget mode.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/emoji.html`,
    );
    const draft = () =>
      page.getByRole("textbox", { name: /Message #general|Reply to thread/ });
    const picker = page.getByRole("button", {
      name: "Insert emoji",
      exact: true,
    });
    await expect(
      page.getByText("Broken :missing:", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Unloadable :broken:", { exact: true }),
    ).toBeVisible();
    const sentSingleEmoji = page.locator("p[data-single-emoji]");
    await expect(sentSingleEmoji).toHaveCSS("font-size", "42px");
    await expect(sentSingleEmoji).toHaveCSS("margin-top", "4px");
    await expect(sentSingleEmoji.locator('img[alt=":party:"]')).toHaveCSS(
      "width",
      "42px",
    );
    await expect(sentSingleEmoji.locator('img[alt=":party:"]')).toHaveCSS(
      "height",
      "42px",
    );
    expect(
      await sentSingleEmoji.evaluate((message) => {
        const byline = message.previousElementSibling;
        const emoji = message.querySelector("img");
        return (
          emoji.getBoundingClientRect().top -
          byline.getBoundingClientRect().bottom
        );
      }),
    ).toBeCloseTo(4, 1);
    await expect(
      page.getByRole("link", { name: "https://example.test/:party" }),
    ).toHaveAttribute("href", "https://example.test/:party");
    const historic = page.locator('img[src*="original.png"]');
    const originalSrc = await historic.getAttribute("src");
    expect(originalSrc).toContain("/emoji-media/a/");
    await expect(page.locator('img[src*="reaction.png"]')).toHaveCount(1);
    // Preserve real pointer selection, then observe the app's native copy event
    // payload directly. Linux WebKit does not paste a script-installed DOM range
    // from its platform clipboard, even though the handler populated the event.
    const emojiImage = sentSingleEmoji.locator("img");
    const copyBounds = await emojiImage.boundingBox();
    await page.mouse.move(
      copyBounds.x - 2,
      copyBounds.y + copyBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      copyBounds.x + copyBounds.width + 2,
      copyBounds.y + copyBounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    expect(
      await emojiImage.evaluate((image) => {
        const selection = window.getSelection();
        return (
          !!selection &&
          !selection.isCollapsed &&
          selection.containsNode(image, true)
        );
      }),
    ).toBe(true);
    const observeCopyPayload = () =>
      page.evaluate(() => {
        window.__emojiCopyPayload = undefined;
        document.addEventListener(
          "copy",
          (event) => {
            window.__emojiCopyPayload = {
              prevented: event.defaultPrevented,
              text: event.clipboardData?.getData("text/plain"),
              trusted: event.isTrusted,
            };
          },
          { once: true },
        );
      });
    const copyPayload = () => page.evaluate(() => window.__emojiCopyPayload);
    const copySelection = async () => {
      if (browserName === "webkit") {
        // Headless WebKit does not dispatch Copy for selected non-editable content
        // from Playwright keyboard input on Linux. Invoke its browser copy command;
        // this uses the real selection and document listener, not a synthetic event.
        expect(await page.evaluate(() => document.execCommand("copy"))).toBe(
          true,
        );
        return;
      }
      await page.keyboard.press("ControlOrMeta+c");
    };
    await emojiImage.evaluate((image) => {
      const range = document.createRange();
      range.selectNode(image);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await observeCopyPayload();
    await copySelection();
    await expect
      .poll(copyPayload)
      .toEqual({ prevented: true, text: ":party:", trusted: true });
    await historic.evaluate((image) => {
      const range = document.createRange();
      range.selectNodeContents(image.closest("p"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await observeCopyPayload();
    await copySelection();
    await expect.poll(copyPayload).toEqual({
      prevented: true,
      text: "Historic :unknown:party: and https://example.test/:party:",
      trusted: true,
    });
    const table = page.locator("table");
    await expect(table.locator('img[alt=":party:"]')).toHaveCount(1);
    await table.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await observeCopyPayload();
    await copySelection();
    await expect.poll(copyPayload).toEqual({
      prevented: true,
      text: "State\tOwner\tCount\tTail\n:party:\t\t12\t\n\tlead\t\tend",
      trusted: true,
    });
    await table
      .locator("tbody tr")
      .first()
      .evaluate((row) => {
        const range = document.createRange();
        range.selectNodeContents(row);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await observeCopyPayload();
    await copySelection();
    await expect.poll(copyPayload).toEqual({
      prevented: true,
      text: ":party:\t\t12\t",
      trusted: true,
    });
    const blockquote = page.locator("blockquote");
    const preformatted = blockquote.locator("xpath=following-sibling::pre[1]");
    await expect(blockquote.locator('img[alt=":party:"]')).toHaveCount(1);
    await blockquote.evaluate((element) => {
      const start = element.querySelector("p")?.firstChild;
      const end = element.nextElementSibling?.querySelector("code")?.lastChild;
      if (!start || !end) throw new Error("Missing quote/code text boundaries");
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(preformatted).toContainText("code");
    await observeCopyPayload();
    await copySelection();
    await expect.poll(copyPayload).toEqual({
      prevented: true,
      text: "Quote :party:\n\ncode\n",
      trusted: true,
    });
    // Independently prove this browser's real clipboard transport with the exact
    // handler payload; the editable source path intentionally uses native copy.
    await draft().fill(":party:");
    await draft().press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");
    await draft().fill("");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(draft()).toHaveJSProperty("value", ":party:");
    // One Shift+Left selects one rendered custom emoji, not its trailing colon.
    await draft().press("Shift+ArrowLeft");
    expect(
      await draft().evaluate((element) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      ),
    ).toBe(":party:");
    await page.keyboard.press("ControlOrMeta+c");
    await draft().fill("");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(draft()).toHaveJSProperty("value", ":party:");
    await draft().fill(":party::party:");
    const selectedDraftText = () =>
      draft().evaluate((element) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      );
    for (const [key, selected] of [
      ["Shift+ArrowLeft", ":party:"],
      ["Shift+ArrowLeft", ":party::party:"],
      ["Shift+ArrowRight", ":party:"],
      ["Shift+ArrowRight", ""],
    ]) {
      await draft().press(key);
      await expect.poll(selectedDraftText).toBe(selected);
    }
    await draft().evaluate((element) => element.setSelectionRange(0, 0));
    for (const [key, selected] of [
      ["Shift+ArrowRight", ":party:"],
      ["Shift+ArrowRight", ":party::party:"],
      ["Shift+ArrowLeft", ":party:"],
      ["Shift+ArrowLeft", ""],
    ]) {
      await draft().press(key);
      await expect.poll(selectedDraftText).toBe(selected);
    }
    await draft().fill(":party:hello");
    await draft().evaluate((element) => element.setSelectionRange(7, 7));
    await draft().press("Shift+ArrowLeft");
    await expect.poll(selectedDraftText).toBe(":party:");
    await draft().press("Backspace");
    await expect(draft()).toHaveJSProperty("value", "hello");
    // Visible source text and unavailable emoji retain ordinary character selection.
    for (const literal of [":unknown:", ":nosource:"]) {
      await draft().fill(literal);
      await draft().press("Shift+ArrowLeft");
      await expect.poll(selectedDraftText).toBe(":");
    }
    await page.locator("main").evaluate((main) => {
      main.style.width = "300px";
    });
    await draft().fill(Array(24).fill(":party:").join(" "));
    const largeCustom = draft();
    await expect(largeCustom.locator("img[data-copy-emoji]")).toHaveCount(24);
    await expect(largeCustom.locator("img[data-copy-emoji]").last()).toHaveCSS(
      "width",
      "42px",
    );
    expect(
      await largeCustom.evaluate(
        (group) => group.scrollWidth <= group.clientWidth,
      ),
    ).toBe(true);
    expect(
      await largeCustom
        .locator("img[data-copy-emoji]")
        .last()
        .evaluate((image) => image.offsetTop),
    ).toBeGreaterThan(0);
    await page.screenshot({
      path: test.info().outputPath("large-custom-emoji-draft.png"),
    });
    const lastCustomBounds = await largeCustom
      .locator("img[data-copy-emoji]")
      .last()
      .boundingBox();
    const inputBounds = await draft().boundingBox();
    expect(lastCustomBounds.y + lastCustomBounds.height).toBeLessThanOrEqual(
      inputBounds.y + inputBounds.height,
    );
    await page.locator("main").evaluate((main) => {
      main.style.width = "800px";
    });
    await draft().fill("");
    // Opening/reading does not load the Unicode dataset or Mart's global state.
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("emoji-mart")),
      ),
    ).toBe(false);
    await picker.focus();
    await picker.press("Enter");
    const search = page.getByRole("searchbox", {
      name: "Search emoji",
    });
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("placeholder", "Search emoji");
    const categoryNavigation = page.locator("em-emoji-picker #nav");
    const skinTone = categoryNavigation.locator(".buzz-skin-tone-nav-button");
    await expect(skinTone).toHaveAttribute("aria-label", /skin tone/i);
    await expect(categoryNavigation.locator("button").last()).toHaveClass(
      /buzz-skin-tone-nav-button/,
    );
    await expect(
      page.locator("em-emoji-picker .search .skin-tone-button"),
    ).toHaveCount(0);
    await skinTone.hover();
    await expect
      .poll(() =>
        skinTone.evaluate(
          (button) => getComputedStyle(button, "::before").backgroundColor,
        ),
      )
      .toBe("rgb(239, 239, 240)");
    await skinTone.click();
    await expect(skinTone).toHaveAttribute("aria-selected", "");
    const toneMenu = page.locator("em-emoji-picker #root > .menu");
    await expect(toneMenu).toBeVisible();
    await expect(toneMenu).toHaveCSS("z-index", "100");
    // Mart's opening transform temporarily lifts the menu above its final edge.
    // Measure the settled menu: its control-size offset meets the nav flush,
    // which is non-overlapping but does not leave a strictly positive gap.
    await expect(toneMenu).toHaveCSS("transform", "none");
    await expect(toneMenu).toHaveCSS("opacity", "1");
    const toneMenuBox = await toneMenu.boundingBox();
    const categoryNavigationBox = await categoryNavigation.boundingBox();
    expect(toneMenuBox.y + toneMenuBox.height).toBeLessThanOrEqual(
      categoryNavigationBox.y,
    );
    expect(
      await toneMenu.evaluate((menu) => {
        const bounds = menu.getBoundingClientRect();
        const top = menu
          .getRootNode()
          .elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
        return !!top && menu.contains(top);
      }),
    ).toBe(true);
    await toneMenu.locator(".option").nth(1).click();
    await expect(toneMenu).toHaveCount(0);
    await expect(skinTone).toBeFocused();
    await search.focus();
    const searchIcon = page.locator("em-emoji-picker .search .loupe svg");
    await expectPhosphor(searchIcon, "magnifying-glass");
    await expect(
      page.locator("em-emoji-picker .search .loupe svg:visible"),
    ).toHaveCount(1);
    await expect(page.locator("em-emoji-picker .search .loupe")).toHaveCSS(
      "visibility",
      "visible",
    );
    const searchField = page.locator("em-emoji-picker .search-field");
    await expect(searchField).toHaveCSS("height", "40px");
    await expect(search).toHaveCSS("margin-left", "0px");
    await expect(search).toHaveCSS("margin-right", "0px");
    await expect(search).toHaveCSS("border-top-width", "0px");
    await expect(searchField).toHaveCSS("border-radius", "159984px");
    await expect(searchField).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect(search).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(search).toHaveCSS("outline-style", "none");
    await expect(search).toHaveCSS("box-shadow", "none");
    const expectSearchAlignment = async () => {
      const offsets = await searchField.evaluate((field) => {
        const bounds = field.getBoundingClientRect();
        return [...field.querySelectorAll("input, svg")].map((element) => {
          const rect = element.getBoundingClientRect();
          return Math.abs(
            rect.top + rect.height / 2 - bounds.top - bounds.height / 2,
          );
        });
      });
      for (const offset of offsets) expect(offset).toBeLessThan(1);
    };
    await expectSearchAlignment();
    const surface = page.locator("em-emoji-picker #root");
    const region = page.getByRole("dialog", { name: "Emoji picker" });
    await expect(surface).toHaveAttribute("data-theme", "light");
    await expect(region).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(region).toHaveCSS("border-radius", "24px");
    await expect(region).toHaveCSS("border-top-width", "1px");
    await expect(region).not.toHaveCSS("box-shadow", "none");
    await expect(
      page.getByRole("button", { name: "Refresh emoji" }),
    ).toHaveCount(0);
    await expect(surface).toHaveCSS("width", "360px");
    const initialRegion = await region.boundingBox();
    const initialSurface = await surface.boundingBox();
    const searchGutters = await searchField.evaluate((input) => {
      const searchBounds = input.getBoundingClientRect();
      const rootBounds = input
        .getRootNode()
        .querySelector("#root")
        .getBoundingClientRect();
      return {
        top: searchBounds.top - rootBounds.top,
        left: searchBounds.left - rootBounds.left,
        right: rootBounds.right - searchBounds.right,
      };
    });
    expect(searchGutters.left).toBeCloseTo(searchGutters.right, 1);
    expect(searchGutters.top).toBe(12);
    expect(searchGutters.left).toBe(12);
    const searchBox = await search.boundingBox();
    const searchIconBox = await searchIcon.boundingBox();
    expect(searchIconBox.y + searchIconBox.height / 2).toBeCloseTo(
      searchBox.y + searchBox.height / 2,
      1,
    );
    expect(initialSurface.height).toBeCloseTo(
      Math.min(348, page.viewportSize().height * 0.4),
      1,
    );
    expect(initialRegion.width).toBe(initialSurface.width + 2);
    expect(initialRegion.height).toBe(initialSurface.height + 2);
    expect(initialRegion.x + 1).toBe(initialSurface.x);
    expect(initialRegion.y + 1).toBe(initialSurface.y);
    await page.screenshot({
      path: test.info().outputPath("emoji-picker-dark-os.png"),
    });
    await search.fill("face");
    const searchResults = page.locator(
      "em-emoji-picker .scroll .category button",
    );
    await expect(searchResults.first()).toBeVisible();
    expect(await searchResults.count()).toBeGreaterThanOrEqual(6);
    const searchRowPositions = await searchResults.evaluateAll((buttons) =>
      buttons.slice(0, 6).map((button) => {
        const bounds = button.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y };
      }),
    );
    expect(
      searchRowPositions.every(({ y }) => y === searchRowPositions[0].y),
    ).toBe(true);
    await search.fill("party");
    const emojiClear = page.locator("em-emoji-picker .search .delete");
    await expect(emojiClear).toHaveCSS("position", "static");
    await expect(emojiClear).toHaveCSS("width", "32px");
    await expect(emojiClear).toHaveCSS("height", "32px");
    await expect(emojiClear.locator("svg")).toHaveAttribute(
      "viewBox",
      "0 0 256 256",
    );
    await expect(emojiClear.locator("svg")).toHaveCSS("width", "16px");
    await expect(emojiClear.locator("svg")).toHaveCSS("height", "16px");
    await expect(emojiClear).toHaveCSS("color", "rgb(102, 102, 102)");
    await expectPhosphor(emojiClear.locator("svg"), "x");
    await expect(emojiClear.locator("svg path")).toHaveCSS(
      "fill",
      "rgb(102, 102, 102)",
    );
    const clearBox = await emojiClear.boundingBox();
    const fieldBox = await search.boundingBox();
    expect(clearBox.y + clearBox.height / 2).toBeCloseTo(
      fieldBox.y + fieldBox.height / 2,
      1,
    );
    // Mart recreates the clear control when search empties, and on picker remount.
    await search.fill("");
    await expect(emojiClear).toHaveCount(0);
    await search.fill("party");
    await expectPhosphor(emojiClear.locator("svg"), "x");
    await picker.click();
    await expect(page.locator("em-emoji-picker")).toHaveCount(0);
    await picker.click();
    await search.fill("party");
    await expectPhosphor(emojiClear.locator("svg"), "x");
    await expect(
      page.locator("em-emoji-picker .search .loupe svg:visible"),
    ).toHaveCount(1);
    const insert = page.getByRole("button", {
      name: ":party:",
      exact: true,
    });
    await expect(insert).toBeVisible();
    await expect(insert).toHaveCSS("width", "48px");
    await expect(insert).toHaveCSS("height", "48px");
    await expect(insert).toHaveCSS("font-size", "36px");
    await expect(insert.locator("img")).toHaveCSS("max-width", "32px");
    await expect(insert.locator("img")).toHaveCSS("max-height", "32px");
    const searchNode = await search.elementHandle();
    // Exercise the actual widget boundary without recreating the picker/search.
    for (const mode of ["dark", "light"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      await expect(surface).toHaveAttribute("data-theme", mode);
      await expect(searchField).toHaveCSS(
        "background-color",
        mode === "dark" ? "rgb(26, 26, 26)" : "rgb(255, 255, 255)",
      );
      await expect(search).toHaveCSS("box-shadow", "none");
      await expect(search).toHaveCSS("font-family", /Inter Variable/);

      await expect(search).toHaveValue("party");
      await expect(search).toBeFocused();
      expect(await searchNode.evaluate((node) => node.isConnected)).toBe(true);
    }
    // Exercise the shared composer's containing-block sizing in a clipped 300px pane.
    await page.locator("main").evaluate((el) => {
      el.style.width = "300px";
    });
    await expect(page.locator("em-emoji-picker #root")).toHaveCSS(
      "width",
      // 300px pane minus 32px composer margins and both surface borders.
      // The popup uses the composer width, including its toolbar padding.
      "264px",
    );
    await expect(search).toHaveValue("party");
    await expect(page.locator("em-emoji-picker nav")).toHaveCount(0);
    // Reflow can move this standalone fixture below the viewport. CSS visibility
    // alone does not establish that elementFromPoint can reach every result.
    await region.scrollIntoViewIfNeeded();
    const narrowRegion = await region.boundingBox();
    const narrowSurface = await surface.boundingBox();
    expect(narrowRegion.width).toBe(narrowSurface.width + 2);
    expect(narrowRegion.height).toBe(narrowSurface.height + 2);
    expect(narrowRegion.x + 1).toBe(narrowSurface.x);
    expect(narrowRegion.y + 1).toBe(narrowSurface.y);
    const pane = await page.locator("main").boundingBox();
    const popover = await page
      .getByRole("dialog", { name: "Emoji picker" })
      .boundingBox();
    expect(popover.x).toBeGreaterThanOrEqual(pane.x);
    expect(popover.x + popover.width).toBeLessThanOrEqual(pane.x + pane.width);
    expect(
      await insert.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(
          el.getRootNode().elementFromPoint(r.right - 2, r.top + r.height / 2),
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("community-emoji-picker.png"),
    });
    // Every result, including the last column, fits and is hit-testable in shadow DOM.
    const results = page.locator("em-emoji-picker .category button");
    expect(await results.count()).toBeGreaterThan(5);
    for (const button of await results.all()) {
      if (!(await button.isVisible())) continue;
      expect(
        await button.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            el
              .getRootNode()
              .elementFromPoint(r.right - 2, r.top + r.height / 2),
          );
        }),
      ).toBe(true);
    }
    await page.locator("main").evaluate((el) => {
      el.style.width = "800px";
    });
    await expect(page.locator("em-emoji-picker #root")).toHaveCSS(
      "width",
      "360px",
    );
    await search.fill("");
    const frequent = page.locator(
      'em-emoji-picker [data-id="frequent"] button',
    );
    await expect(frequent.first()).toBeVisible();
    const navigation = page.locator("em-emoji-picker nav");
    await expect(navigation).toBeVisible();
    for (const [category, icon] of Object.entries({
      "Frequently used": "clock",
      "Smileys & People": "smiley",
      "Animals & Nature": "paw-print",
      "Food & Drink": "orange",
      Activity: "barbell",
      "Travel & Places": "car",
      Objects: "lightbulb",
      Symbols: "shapes",
      Flags: "flag",
      Custom: "asterisk",
    })) {
      const categoryIcon = navigation
        .getByRole("button", { name: category, exact: true })
        .locator("svg");
      await expectPhosphor(categoryIcon, icon);
    }
    const selectedCategory = navigation.locator("button[aria-selected]");
    const expectSelectionPaint = async () => {
      await expect
        .poll(() =>
          selectedCategory.evaluate((element) => {
            const selected = getComputedStyle(element, "::before");
            const other = element.parentElement.querySelector(
              "button:not([aria-selected])",
            );
            const unselected = getComputedStyle(other, "::before");
            return (
              selected.content !== "none" &&
              selected.display !== "none" &&
              Number(selected.opacity) > 0 &&
              parseFloat(selected.width) > 0 &&
              parseFloat(selected.height) > 0 &&
              selected.backgroundColor !== "rgba(0, 0, 0, 0)" &&
              selected.backgroundColor !== unselected.backgroundColor
            );
          }),
        )
        .toBe(true);
    };
    await expectSelectionPaint();
    const selectedDuration = () =>
      selectedCategory.evaluate(
        (element) => getComputedStyle(element, "::before").transitionDuration,
      );
    const categoryPositions = await navigation
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().x),
      );
    await navigation.getByRole("button", { name: "Smileys & People" }).click();
    expect(
      await navigation
        .locator("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getBoundingClientRect().x),
        ),
    ).toEqual(categoryPositions);
    await expect(
      navigation.getByRole("button", { name: "Smileys & People" }),
    ).toHaveAttribute("aria-selected", "true");
    await expectSelectionPaint();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(selectedDuration).toBe("0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.getByText("Pick an emoji", { exact: true })).toHaveCount(
      0,
    );
    const rootBox = await surface.boundingBox();
    const navBox = await navigation.boundingBox();
    expect(navBox.y).toBeGreaterThan(rootBox.y + rootBox.height / 2);
    await search.fill("party");
    await expect(insert.locator("img")).toHaveAttribute(
      "src",
      /emoji-media\/a\/.*1.png/,
    );
    const retiredPicker = await page.locator("em-emoji-picker").elementHandle();
    const retiredTheme = await retiredPicker.getAttribute("theme");
    await search.press("Escape");
    await expect(picker).toBeFocused();
    await page.evaluate(async () => {
      document.documentElement.dataset.colorMode = "dark";
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    expect(await retiredPicker.evaluate((el) => el.isConnected)).toBe(false);
    // Closing owns the mode observer too; a retired widget must not update.
    expect(await retiredPicker.getAttribute("theme")).toBe(retiredTheme);
    await picker.click();
    // Newly opened widgets must start in the selected mode without a later toggle.
    await expect(surface).toHaveAttribute("data-theme", "dark");
    for (const query of [
      "party-parrot",
      "party parrot",
      "parrot",
      ":party-parrot:",
    ]) {
      await search.fill(query);
      await expect(
        page.getByRole("button", { name: ":party-parrot:", exact: true }),
      ).toBeVisible();
    }
    for (const query of [
      "party-parrot-wave",
      ":party-parrot-wave:",
      "party parrot wave",
    ]) {
      await search.fill(query);
      await expect(
        page.getByRole("button", { name: ":party-parrot-wave:", exact: true }),
      ).toBeVisible();
    }
    await search.fill("aonly");
    await search.press("Enter");
    await expect(draft()).toHaveJSProperty("value", ":aonly:");
    await picker.click();
    await search.fill("");
    await expect(
      page.locator(
        'em-emoji-picker [data-id="frequent"] img[src*="aonly.png"]',
      ),
    ).toHaveCount(1);
    await search.fill("grinning");
    await expect(
      page.getByRole("button", { name: ":grinning:", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(draft()).toHaveJSProperty("value", ":aonly:😀");
    await draft().fill("before after");
    await draft().evaluate((el) => el.setSelectionRange(7, 7));
    await picker.press("Enter");
    await search.focus();
    await search.fill("party");
    await search.press("Enter");
    await expect(draft()).toHaveJSProperty("value", "before :party:after");
    await expect(draft()).toBeFocused();
    await draft().press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(1);
    const first = await page.evaluate(
      () => window.emojiFixture.report.publications[0],
    );
    expect(first.community).toBe("a");
    expect(first.event.tags).toContainEqual([
      "emoji",
      "party",
      "https://a.test/media/1.png",
    ]);
    await expect(historic).toHaveAttribute("src", originalSrc);
    await picker.click();
    await search.fill("party");
    await page.evaluate(() => window.emojiFixture.replace());
    await expect(search).toHaveValue("party");
    await expect(insert.locator("img")).toHaveAttribute("src", /2.png/);
    await search.press("Escape");
    await draft().fill("A draft");
    await page.getByRole("button", { name: "Switch community" }).click();
    await expect(draft()).toHaveJSProperty("value", "");
    await expect
      .poll(() => page.evaluate(() => window.emojiFixture.status("b")))
      .toBe("ready");
    await picker.click();
    await search.fill("aonly");
    await expect(
      page.getByRole("button", { name: ":aonly:", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator('em-emoji-picker img[src*="emoji-media/a/"]'),
    ).toHaveCount(0);
    await search.fill("");
    await expect(
      page.locator('em-emoji-picker img[src*="aonly.png"]'),
    ).toHaveCount(0);
    await search.fill("party");
    await expect(insert.locator("img")).toHaveAttribute(
      "src",
      /emoji-media\/b\/.*1.png/,
    );
    await insert.click();
    await expect(draft()).toHaveJSProperty("value", ":party:");
    await expect(draft()).toBeFocused();
    await draft().press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(2);
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await picker.click();
    await search.fill("party");
    await insert.click();
    await expect(draft()).toHaveJSProperty("value", ":party:");
    await expect(draft()).toBeFocused();
    await draft().press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(3);
    const replies = await page.evaluate(() =>
      window.emojiFixture.report.publications.slice(1),
    );
    for (const { community, event } of replies) {
      expect(community).toBe("b");
      expect(event.tags).toContainEqual([
        "emoji",
        "party",
        "https://b.test/media/1.png",
      ]);
    }
    expect(
      replies[1].event.tags.some((tag) => tag[0] === "e" && tag[3] === "reply"),
    ).toBe(true);
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await page.getByRole("button", { name: "Switch community" }).click();
    await expect(draft()).toHaveJSProperty("value", "A draft");
    await picker.click();
    await page.evaluate(async () => {
      window.emojiFixture.fail(true);
      await window.emojiFixture.refresh();
    });
    await expect(page.getByRole("alert")).toContainText(
      "Fixture catalog offline",
    );
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(draft()).toHaveJSProperty("value", "😀A draft");
    // The shared popup retains its contents through its exit transition.
    // Finish that lifecycle before inspecting the separate composer error.
    await expect(region).toHaveCount(0);
    await draft().fill(":party:");
    await draft().press("Enter");
    await expect(draft()).toHaveJSProperty("value", ":party:");
    await expect(page.getByRole("alert")).toContainText(
      "Community emoji unavailable",
    );
    await picker.click();
    await expect(region.getByRole("alert")).toContainText(
      "Fixture catalog offline",
    );
    await page.evaluate(() => {
      window.emojiFixture.fail(false);
      window.emojiFixture.holdCatalog();
    });
    try {
      await page
        .getByRole("button", { name: "Retry emoji", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.emojiFixture.status("a")))
        .toBe("loading");
      // A usable Unicode-only picker during loading is not the recovered mount.
      await expect(search).toHaveAttribute("data-buzz-search-ready", "true");
      await expect(
        page.locator('em-emoji-picker [data-id="buzz-custom"]'),
      ).toHaveCount(0);
    } finally {
      await page.evaluate(() => window.emojiFixture.releaseCatalog());
    }
    await expect
      .poll(() => page.evaluate(() => window.emojiFixture.status("a")))
      .toBe("ready");
    await expect(
      page.locator('em-emoji-picker [data-id="buzz-custom"]'),
    ).toHaveCount(1);
    await expect(search).toHaveAttribute("data-buzz-search-ready", "true");
    await search.fill("party");
    await expect(insert).toBeVisible();
    await draft().fill(":broken: readable");
    await expect(draft()).toContainText(":broken: readable");
    await draft().fill(":broken: :nosource:");
    await expect(draft()).toContainText(":broken: :nosource:");
    await expect(draft()).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
    const longDraft = `:party: ${"long text ".repeat(160)}`;
    await draft().fill(longDraft);
    await expect(draft()).toHaveJSProperty("value", longDraft);
    await expect(draft()).toContainText("long text long text");
    await expect(draft().locator("img[data-copy-emoji]")).toHaveCount(1);
    await expect
      .poll(() =>
        draft().evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(0);
    await draft().evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => draft().evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await draft().fill("");
    await page.evaluate(() => window.emojiFixture.remove());
    await expect(search).toHaveValue("party");
    await expect(insert).toHaveCount(0);
    await expect(
      page.locator('em-emoji-picker [data-id="buzz-custom"]'),
    ).toHaveCount(0);
    await expect(historic).toHaveAttribute("src", originalSrc);
    await search.fill("");
    await expect(
      page.locator('em-emoji-picker img[src*="emoji-media"]'),
    ).toHaveCount(0);
    await search.fill("aonly");
    await expect(
      page.getByRole("button", { name: ":aonly:", exact: true }),
    ).toHaveCount(0);
    await search.press("Escape");
    await picker.click();
    await search.fill("party");
    await expect(insert).toHaveCount(0);
    await search.press("Escape");
    await draft().fill("");
    await picker.click();
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(draft()).toHaveAttribute("data-single-emoji", "true");
    await expect(draft()).toHaveCSS("font-size", "42px");
    await draft().fill("😀 🙏 👏");
    await expect(draft()).toHaveAttribute("data-single-emoji", "true");
    await expect(draft()).toHaveCSS("font-size", "42px");
    await draft().fill("😀 🙏 👏 😄");
    await expect(draft()).toHaveAttribute("data-single-emoji", "true");
    await expect(draft()).toHaveCSS("font-size", "42px");
    await draft().fill("😀 🙏 👏 hello");
    await expect(draft()).not.toHaveAttribute("data-single-emoji", "true");
    const bodySize = await draft().evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.fontSize = "var(--text-body)";
      element.parentElement.append(probe);
      const size = getComputedStyle(probe).fontSize;
      probe.remove();
      return size;
    });
    await expect(draft()).toHaveCSS("font-size", bodySize);
    const publicationCount = await page.evaluate(
      () => window.emojiFixture.report.publications.length,
    );
    await draft().press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(publicationCount + 1);
    expect(
      await page.evaluate(
        () => window.emojiFixture.report.publications.at(-1).event.content,
      ),
    ).toBe("😀 🙏 👏 hello");
    expect(errors.unexplained()).toEqual([]);
  } finally {
    try {
      await server?.close();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
});
