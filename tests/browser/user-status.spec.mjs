import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test("statuses edit, synchronize, clear, reject stale traffic and retain failed drafts", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, open: false },
    preview: { open: false },
  });
  const errors = watchPageErrors(page);
  try {
    await page.route("https://emoji.test/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="purple"/></svg>',
      }),
    );
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/user-status.html`,
    );
    const navigation = page.getByRole("region", {
      name: "Navigation",
      exact: true,
    });
    const chat = page.getByRole("region", { name: "Chat", exact: true });
    const second = page.getByRole("region", {
      name: "Second device",
      exact: true,
    });
    const open = async () => {
      await page
        .getByRole("button", { name: "Your profile", exact: true })
        .click();
      await page
        .getByRole("menu", { name: "Alice" })
        .getByRole("menuitem", { name: /^Set a status/ })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Set a status" }),
      ).toBeVisible();
    };
    const editor = page.getByRole("dialog", { name: "Set a status" });
    await open();
    await expect(
      editor.getByRole("button", { name: "Save status", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Duration: Today", exact: true }),
    ).toBeVisible();
    const emojiButton = editor.getByRole("button", {
      name: "Choose a status emoji",
    });
    await editor.getByLabel("Status message").fill("Typing");
    await expect(emojiButton).toHaveText("💬");
    await editor.getByLabel("Status message").fill("   ");
    await expect(emojiButton).not.toHaveText("💬");
    await editor.getByLabel("Status message").fill("Design meeting");
    await expect(emojiButton).toHaveText("💬");
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Design meeting",
    );
    await page.evaluate(() => window.statusPublication.hold());
    try {
      await editor
        .getByRole("button", { name: "Save status", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.statusPublication.pending()))
        .toBe(true);
      await expect(editor).toBeVisible();
      await expect(
        editor.getByRole("button", { name: "Save status" }),
      ).toBeDisabled();
    } finally {
      await page.evaluate(() => window.statusPublication.release());
    }
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeFocused();
    await expect(chat.locator('[aria-label="💬 Design meeting"]')).toHaveCount(
      0,
    );
    await expect(chat.getByText("Design meeting", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      second.getByText("Design meeting", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reject next save" }).click();
    await open();
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Design meeting",
    );
    await expect(
      editor.getByRole("button", { name: /^Duration:/ }),
    ).toHaveAttribute("aria-label", "Duration: Today");
    await editor.getByLabel("Status message").fill("Draft retained");
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText(
      "Fixture save rejected",
    );
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Draft retained",
    );
    await editor.getByRole("button", { name: "Choose a status emoji" }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("bus");
    await page.getByRole("button", { name: "🚌", exact: true }).click();
    await editor.getByLabel("Status message").fill("");
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(second.getByText("🚌", { exact: true })).toBeVisible();
    await open();
    await editor.getByRole("button", { name: "Choose a status emoji" }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("party");
    const custom = page.getByRole("button", { name: ":party:", exact: true });
    await expect(custom).toBeVisible();
    await custom.click();
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(
      second.getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await expect(
      chat.getByRole("img", { name: ":party:", exact: true }),
    ).toHaveCount(0);
    await open();
    await editor.getByRole("button", { name: "Clear status" }).click();
    await expect(editor).toBeHidden();
    await expect(second.getByRole("img")).toHaveCount(0);
    await expect(
      chat.getByRole("img", { name: ":party:", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Update Bob", exact: true }).click();
    await expect(
      navigation.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    const dmName = navigation.locator(
      '[data-channel-id="status-dm"] .navigation-item-label',
    );
    await expect(dmName).toContainText("Bob");
    await expect(
      dmName.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    const dmStatusLayout = await dmName.evaluate((label) => {
      const nameContent = label.firstElementChild;
      const name = nameContent?.firstElementChild;
      const status = label.querySelector('[aria-label="🏠 Working remotely"]');
      if (!(name instanceof HTMLElement) || !(status instanceof HTMLElement))
        throw new Error("Missing DM name or status");
      const nameBounds = name.getBoundingClientRect();
      const statusBounds = status.getBoundingClientRect();
      const contentBounds = nameContent.getBoundingClientRect();
      return {
        hasAccessoryContract: nameContent.hasAttribute("data-name-accessory"),
        nameWidth: nameBounds.width,
        nameScrollWidth: name.scrollWidth,
        nameRight: nameBounds.right,
        statusLeft: statusBounds.left,
        statusRight: statusBounds.right,
        contentRight: contentBounds.right,
        labelRight: label.getBoundingClientRect().right,
      };
    });
    expect(dmStatusLayout.hasAccessoryContract).toBe(true);
    expect(dmStatusLayout.nameWidth).toBeCloseTo(
      dmStatusLayout.nameScrollWidth,
      0,
    );
    expect(dmStatusLayout.statusLeft - dmStatusLayout.nameRight).toBe(8);
    expect(dmStatusLayout.contentRight).toBe(dmStatusLayout.statusRight);
    expect(
      dmStatusLayout.labelRight - dmStatusLayout.statusRight,
    ).toBeGreaterThan(20);
    await expect(dmName.locator("[tabindex]")).toHaveCount(0);
    // Real text geometry catches a full-width label pushing the status away.
    const expectStatusBesideName = async () => {
      await expect
        .poll(() =>
          dmName.evaluate((element) => {
            const label = element.firstElementChild.firstElementChild;
            const status = element.querySelector("[data-compact]");
            const range = document.createRange();
            range.selectNodeContents(label);
            const textRight = Math.min(
              range.getBoundingClientRect().right,
              label.getBoundingClientRect().right,
            );
            return Math.round(status.getBoundingClientRect().left - textRight);
          }),
        )
        .toBe(8);
    };
    await expectStatusBesideName();
    await dmName.locator('[aria-label="🏠 Working remotely"]').hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toContainText(
      "Working remotely",
    );
    const bobByline = chat
      .locator('[data-message-id="Bob"] strong')
      .locator("..");
    await expect(
      bobByline.locator('[aria-label="🏠 Working remotely"]'),
    ).toHaveCount(0);
    await expect(bobByline.locator("[tabindex]")).toHaveCount(0);
    await page.getByRole("button", { name: "Replay older Bob" }).click();
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByText("Working remotely", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Custom Bob", exact: true }).click();
    await expect(
      dmName.getByRole("img", { name: ":party: Celebrating", exact: true }),
    ).toBeVisible();
    await expectStatusBesideName();
    await expect(
      bobByline.getByRole("img", { name: ":party: Celebrating", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Text-only Bob", exact: true })
      .click();
    await expect(dmName.locator('[aria-label="Buzzy"]')).toHaveText("💬");
    await dmName.locator('[aria-label="Buzzy"]').hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toContainText(
      "Buzzy",
    );
    await expect(bobByline.locator('[aria-label="Buzzy"]')).toHaveCount(0);
    await expect(navigation.getByText("Buzzy", { exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByText("Buzzy", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear Bob", exact: true }).click();
    await page.getByRole("button", { name: "Replay older Bob" }).click();
    await expect(dmName.locator("[data-compact]")).toHaveCount(0);
    await expect(bobByline.locator("[data-compact]")).toHaveCount(0);
    await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
    // A long name must still shrink/fade and leave the status visible.
    await page.goto(
      new URL(
        "?name=Bob with a very long display name that needs to fade in the sidebar",
        page.url(),
      ).href,
    );
    await page.getByRole("button", { name: "Update Bob", exact: true }).click();
    for (const width of [1440, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(dmName.locator("[data-overflowing]")).toHaveCount(1);
      await expectStatusBesideName();
      const status = dmName.locator("[data-compact]");
      await expect(status).toBeVisible();
      await expect
        .poll(() =>
          status.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const row = element.closest("button").getBoundingClientRect();
            return bounds.width >= 15 && bounds.right <= row.right;
          }),
        )
        .toBe(true);
      await expect(dmName.locator("[data-overflowing]")).toHaveCSS(
        "mask-image",
        /linear-gradient/,
      );
    }
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
