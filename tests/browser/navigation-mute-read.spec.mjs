import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only boundary: real shared-menu focus/dismissal, production broker,
// IndexedDB reload and app-global preference startup. Policy matrices live in Vitest.
test.use({
  productionBroker: true,
  readState: true,
  savedSidebar: true,
  historyCounts: { alpha: 8, beta: 6 },
});

test("channel menu mute/read persist without selecting the row; failed mute remains retryable", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
  });
  await open(page, app);
  // Context menus make the rest of the page aria-hidden while open.
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
    includeHidden: true,
  });
  const beta = sidebar.locator('[data-channel-id="beta"]');
  const alpha = sidebar.locator('[data-channel-id="alpha"]');
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  const badge = (row) =>
    row.getByRole("img", { name: /observed unread messages/ });
  await expect(badge(beta)).toHaveAttribute(
    "aria-label",
    /^6 observed unread messages/,
  );
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  // This fixture's legacy "beta" id cannot authorize lifecycle commands. Its
  // failed permission group must not remove or disable the existing actions.
  await expect(menu.getByRole("alert")).toHaveText(
    "Channel actions unavailable",
  );
  await expect(menu.getByRole("menuitem")).toHaveText([
    "New session",
    "Move channel",
    "Mute",
    "Mark as Read",
    "Retry channel permissions",
  ]);
  await expect(menu.getByRole("separator")).toHaveCount(3);
  for (const name of ["Mute", "Mark as Read"]) {
    await expect(
      menu
        .getByRole("menuitem", { name, exact: true })
        .locator(".buzz-menu-icon"),
    ).toHaveAttribute("aria-hidden", "true");
  }
  await expect(
    sidebar.getByRole("button", { name: /More options/ }),
  ).toHaveCount(0);
  await captureActions(page, menu, testInfo.outputPath("mute-read-menu.png"));
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-mute", async (route) => {
    started();
    await gate;
    app.report.sidebarMuteFailures ??= [];
    app.report.sidebarMuteFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture mute failure" }),
    });
  });
  try {
    await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await requested;
    await expect(menu).toHaveCount(0);
    await expect(beta).toBeFocused();
    await expect(beta.getByLabel(/^(Muting;|Muted;)/)).toHaveCount(0);
    await expect(alpha).toHaveAttribute("aria-current", "page");
    await expect(badge(beta)).toHaveAttribute(
      "aria-label",
      /^6 observed unread messages/,
    );
    // Reopening is usable while the relay is still held; no frozen Saving menu.
    await page.keyboard.press("Shift+F10");
    await expect(
      menu.getByRole("menuitem", { name: "Unmute", exact: true }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("menuitem", { name: "Mark as Read" }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
  } finally {
    release();
  }
  const failure = page.getByRole("dialog", { name: "Couldn’t mute Beta" });
  await expect(failure).toContainText("Relay request failed (502)");
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    menu.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.unroute("**/sidebar-mute");
  // The persistent sidebar keeps retry UI and actions usable outside Messages.
  await openPage(page, "Projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await expect(badge(beta)).toHaveAttribute(
    "aria-label",
    /^6 observed unread messages/,
  );
  await expect
    .poll(() => app.report.sidebarPublications?.at(-1))
    .toMatchObject({
      coordinate: "channel-mutes",
      blob: { channels: { beta: { muted: true } } },
    });
  await page.keyboard.press("ContextMenu");
  await expect(
    menu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: "Mark as Read" }).click();
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await expect(badge(beta)).toHaveCount(0);
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await expect(alpha).not.toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        app.report.readPublications.some(
          ({ blob }) =>
            blob.contexts.beta ===
            app.histories.get("primary/beta").at(-1).created_at,
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await readStateSettled(page);
  await page.reload();
  await openPage(page, "Messages");
  await beta.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await expect(beta.getByLabel(/^(Muting;|Muted;)/)).toHaveCount(0);
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await expect(badge(beta)).toHaveCount(0);
  await beta.click({ button: "right" });
  const markUnread = menu.getByRole("menuitem", {
    name: "Mark as Unread",
    exact: true,
  });
  await expect(markUnread).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Mark as Read", exact: true }),
  ).toHaveCount(0);
  await captureActions(page, menu, testInfo.outputPath("mark-unread-menu.png"));
  await markUnread.click();
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  const localMark = beta.getByRole("img", {
    name: "Marked unread on this device only",
  });
  await expect(localMark).toBeVisible();
  await expect(alpha).toHaveAttribute("aria-current", "page");
  // Cold preferences can relocate the row while a read-state transaction waits
  // on startup. Control both responses so focus restoration crosses that remount.
  const preferences = holdResponse(page, "**/sidebar-preferences");
  const reads = holdResponse(page, "**/read-state-decode");
  await Promise.all([preferences.ready, reads.ready]);
  try {
    await page.reload();
    await openPage(page, "Messages");
    await Promise.all([preferences.started, reads.started]);
    await expect(localMark).toBeVisible();
    await expect(beta).toContainText("Beta");
    await beta.focus();
    await page.keyboard.press("Shift+F10");
    await expect(markUnread).toHaveCount(0);
    await menu
      .getByRole("menuitem", { name: "Mark as Read", exact: true })
      .click();
    await expect(menu.getByRole("status")).toHaveText("Saving…");
    preferences.release();
    await expect(
      sidebar
        .locator("[data-sidebar-section]")
        .filter({ has: page.locator("summary", { hasText: "Work" }) })
        .locator('[data-channel-id="beta"]'),
    ).toBeVisible();
    reads.release();
    await expect(menu).toHaveCount(0);
    await expect(beta).toBeFocused();
  } finally {
    preferences.release();
    reads.release();
    await page.unroute("**/sidebar-preferences");
    await page.unroute("**/read-state-decode");
  }
  await expect(localMark).toHaveCount(0);
  await expect(badge(beta)).toHaveCount(0);
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await page.keyboard.press("Shift+F10");
  await expect(markUnread).toBeVisible();
  const unmute = holdResponse(page, "**/sidebar-mute");
  await unmute.ready;
  try {
    await menu.getByRole("menuitem", { name: "Unmute", exact: true }).click();
    await unmute.started;
    await expect(menu).toHaveCount(0);
    await expect(beta).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await expect(
      menu.getByRole("menuitem", { name: "Mute", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
  } finally {
    unmute.release();
  }
  await expect
    .poll(() => app.report.sidebarPublications.at(-1))
    .toMatchObject({
      coordinate: "channel-mutes",
      blob: { channels: { beta: { muted: false } } },
    });
  await readStateSettled(page);
  await page.reload();
  await openPage(page, "Messages");
  await beta.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // A click in the same instant as Escape can be lost while the row menu
  // dismisses. Open the next menu only after this one has closed.
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  // Removing session entry preserves attention and lifecycle groups; only the
  // separator between those remaining groups survives.
  const toggleSessions = async (enabled) => {
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const toggle = page
      .getByRole("region", { name: "Plugins", exact: true })
      .getByRole("switch", { name: "Enable Sessions", exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(beta).toBeVisible();
  };
  await toggleSessions(false);
  await beta.click({ button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Move channel",
    "Mute",
    "Mark as Unread",
    "Retry channel permissions",
  ]);
  await expect(menu.getByRole("separator")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await toggleSessions(true);
  // The production broker must expose a valid empty agent library when this
  // retained row menu opens the session composer (not just in the local-only host).
  await beta.click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "New session", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message this session", exact: true }),
  ).toBeFocused();
  expect(app.report.unexpected).toEqual([]);
});

// A relay publication is not the end of read-state work: the app still reads
// its own write back and decodes it. WebKit reports a decode cut off by reload
// as a page error, so reload only after the saved journal records acceptance.
async function readStateSettled(page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("buzz-read-state-v1", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("partitions", "readonly");
              const read = tx.objectStore("partitions").getAll();
              read.onsuccess = () => {
                const journal = read.result[0];
                resolve(
                  !!journal &&
                    !journal.pending &&
                    journal.acceptedRevision >= journal.revision,
                );
              };
              read.onerror = () => reject(read.error);
              tx.oncomplete = () => db.close();
            };
          }),
      ),
    )
    .toBe(true);
}

function holdResponse(page, pattern) {
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  const ready = page.route(pattern, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  return { ready, started: requested, release: () => release() };
}

// Capture the real built app menu, without unrelated conversation content.
async function captureActions(page, menu, path) {
  // Page screenshots do not wait for the menu's entrance transition to finish.
  await menu.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const first = await menu.getByRole("menuitem").first().boundingBox();
  const last = await menu
    .getByRole("menuitem", { name: /^Mark as (Read|Unread)$/ })
    .boundingBox();
  if (!first || !last) throw new Error("Read/mute actions are not laid out");
  await page.screenshot({
    path,
    clip: {
      x: first.x - 4,
      y: first.y - 4,
      width: first.width + 8,
      height: last.y + last.height - first.y + 8,
    },
  });
}
