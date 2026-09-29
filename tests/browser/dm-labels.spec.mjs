import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  historyCounts: { alpha: 1, beta: 1 },
});

test("keyboard removal of the final DM moves focus to a surviving section", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await page.locator(".shell-sidebar").evaluate((element) => {
    element.style.width = "220px";
  });
  const identity = sidebar
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .locator("[data-dm-identity]");
  await expect(identity).toBeVisible();
  const participants = sidebar.locator("[data-dm-participant-count]").first();
  await expect(participants).toHaveText("3");
  for (const cue of [identity, participants]) {
    await expect(cue).toBeVisible();
    await expect
      .poll(() =>
        cue.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          // Both outer edges must actually be painted and reachable, not merely
          // intersect the viewport while an ancestor clips the identity cue.
          return [bounds.left + 1, bounds.right - 1].every((x) =>
            element.contains(
              document.elementFromPoint(x, bounds.top + bounds.height / 2),
            ),
          );
        }),
      )
      .toBe(true);
  }
  const dms = sidebar.locator('button[data-channel-id^="dm-"]');
  for (let remaining = await dms.count(); remaining > 0; remaining -= 1) {
    const dm = dms.last();
    await dm.focus();
    await dm.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Remove from Messages", exact: true })
      .click();
    await expect(dms).toHaveCount(remaining - 1);
  }
  await expect(
    sidebar.locator("[data-sidebar-section] details > summary").first(),
  ).toBeFocused();
});

for (const cold of [false, true]) {
  test(`DM names recover after ${cold ? "hidden channel deletion aborts a cold fetch" : "channel deletion purges loaded profiles"}`, async ({
    page,
    app,
  }) => {
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const dm = sidebar.getByRole("button", {
      name: "Alice Fixture",
      exact: true,
    });
    const fallback = sidebar.getByRole("button", {
      name: app.participants[0].slice(0, 10),
      exact: true,
    });
    const labelReads = () =>
      app.report.queries.filter(
        ({ filter }) =>
          filter.kinds?.includes(0) &&
          filter.authors?.includes(app.participants[0]),
      );
    if (cold) {
      app.hideChannel("beta");
      app.relay.holdProfiles(app.participants);
    }
    try {
      await open(page, app);
      if (cold) {
        await expect(fallback).toBeVisible();
        await expect.poll(() => labelReads().length).toBe(1);
        expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
        await expect(
          sidebar.getByRole("button", { name: "Beta", exact: true }),
        ).toHaveCount(0);
      } else {
        await expect(dm).toBeVisible();
        await expect(
          sidebar.getByRole("button", { name: "Beta", exact: true }),
        ).toBeVisible();
        app.relay.holdProfiles(app.participants);
      }
      await expect((cold ? fallback : dm).locator(".buzz-avatar")).toHaveText(
        cold ? app.participants[0][0].toUpperCase() : "A",
      );
      const before = labelReads().length;
      app.omitChannel("beta");
      // The deployed deletion trigger is not under test. Exercise the real
      // refresh -> roster omission -> session purge -> page/hook recovery path.
      await page
        .getByRole("button", { name: "Channel settings", exact: true })
        .click();
      await page.getByText("Diagnostics", { exact: true }).click();
      await page
        .getByRole("button", { name: "Refresh channels", exact: true })
        .click();
      await expect(
        page.getByText("Roster · 3 channels", { exact: true }),
      ).toBeVisible();
      await expect(fallback).toBeVisible();
      await expect(dm).toHaveCount(0);
      await expect.poll(() => labelReads().length).toBe(before + 1);
      if (cold)
        expect(app.report.profileHolds.some((held) => held.aborted)).toBe(true);
      app.relay.releaseProfiles();
      await expect(dm).toBeVisible();
      await expect(fallback).toHaveCount(0);
      await page
        .getByRole("button", { name: "Channel settings", exact: true })
        .click();
      await dm.click();
      await expect(
        page
          .getByRole("article", { name: "Conversation" })
          .getByRole("heading", { level: 2 }),
      ).toHaveText("Alice Fixture");
      expect(labelReads()).toHaveLength(before + 1);
      await expect(dm.locator(".buzz-avatar")).toHaveText("A");
      await expect
        .poll(() =>
          app.report.presenceSnapshots.some((snapshot) =>
            snapshot.filter.authors.includes(app.participants[0]),
          ),
        )
        .toBe(true);
    } finally {
      app.relay.releaseProfiles();
    }
  });
}
