import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  largeSidebar: true,
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 1, beta: 1 },
});

for (const cachedStartup of [false, true]) {
  for (const action of [
    "untouched",
    "scrolled",
    "returned to top",
    "scroll event pending",
  ]) {
    test(`delayed sidebar restoration respects ${action} viewport (cached startup: ${cachedStartup})`, async ({
      page,
      app,
    }) => {
      await open(page, app);
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      // Save a nonzero position, then cold-load that community with preferences held.
      await sidebar.evaluate((element) => {
        element.scrollTop = 900;
        element.dispatchEvent(new Event("scroll"));
      });
      await button(page, "Personal space").click();
      await expect(button(page, "Personal space")).toHaveAttribute(
        "aria-current",
        "true",
      );
      // Preserve delayed-first-layout coverage on a genuine cold launch too.
      // Without a saved roster/preferences record, the first layout waits for
      // fresh preferences; the cached case intentionally restores immediately.
      await page.evaluate(async (keep) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-channel-heads-v1", 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction("startup", "readwrite");
          const store = tx.objectStore("startup");
          const request = store.getAll();
          request.onsuccess = () => {
            for (const row of request.result) {
              if (!keep) store.delete(row.key);
            }
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, cachedStartup);
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const pendingRoutes = [];
      await page.route("**/api/relay/primary/sidebar-preferences", (route) => {
        const pending = held.then(() => route.continue());
        pendingRoutes.push(pending);
        return pending;
      });
      try {
        await page.reload();
        await button(page, "Switch to Primary").click();
        await expect
          .poll(() => sidebar.locator("[data-channel-id]").count())
          .toBeGreaterThan(100);
        await expect.poll(() => pendingRoutes.length).toBeGreaterThan(0);
        const panel = page.getByRole("complementary", {
          name: "Channel sidebar",
        });
        await expect(panel).toHaveAttribute("aria-busy", "true");
        await expect(
          page.getByText("Updating sidebar details…", { exact: true }),
        ).toHaveCount(0);
        // Device preferences now restore the saved position before the held
        // network refresh. Subsequent user intent must still win over that refresh.
        expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(
          cachedStartup ? 900 : 0,
        );
        if (action === "scroll event pending") {
          // Model compositor movement visible before the main-thread scroll
          // callback. The restoration must inspect the current position too.
          await page.evaluate(() => {
            document.addEventListener(
              "scroll",
              (event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.getAttribute("aria-label") ===
                    "Subscribed channels"
                )
                  event.stopImmediatePropagation();
              },
              true,
            );
          });
        }
        if (action !== "untouched") {
          await sidebar.hover({ position: { x: 10, y: 100 } });
          await page.mouse.wheel(0, cachedStartup ? 900 : 1800);
          await expect
            .poll(() => sidebar.evaluate((element) => element.scrollTop))
            .toBe(1800);
        }
        if (action === "returned to top") {
          await page.mouse.wheel(0, -1800);
          await expect
            .poll(() => sidebar.evaluate((element) => element.scrollTop))
            .toBe(0);
        }
        const beforeRefresh = await sidebar.boundingBox();
        const refreshed = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/relay/primary/sidebar-preferences") &&
            response.ok(),
        );
        release();
        await refreshed;
        // DOM settlement follows preference application and its layout effects;
        // the HTTP response alone is not a restoration barrier.
        await expect(panel).not.toHaveAttribute("aria-busy", "true");
        await expect
          .poll(() => sidebar.evaluate((element) => element.scrollTop))
          .toBe(
            action === "untouched"
              ? 900
              : action === "returned to top"
                ? 0
                : 1800,
          );
        expect(await sidebar.boundingBox()).toEqual(beforeRefresh);
      } finally {
        release();
        await Promise.all(pendingRoutes);
        await page.unroute("**/api/relay/primary/sidebar-preferences");
      }
    });
  }
}
