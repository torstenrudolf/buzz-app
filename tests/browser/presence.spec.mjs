import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
test.use({ productionBroker: true, readState: true });

test("profile snapshot and same-socket renewal coexist with real chat while optional response is held", async ({
  page,
  app,
}) => {
  app.relay.holdPresence();
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  await settle(page);
  try {
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    const profile = page.getByRole("region", { name: "Profile details" });
    await expect(profile).toBeVisible();
    await expect(profile.getByRole("img", { name: /^Presence:/ })).toHaveCount(
      0,
    );
    // Narrowing the timeline for the profile can demand an older page. This
    // fixture deliberately holds those pages; retire that foreground work first.
    await expect
      .poll(() => {
        for (const pending of app.pending.splice(0)) pending.release();
        return app.report.presenceSnapshots.some(
          (snapshot) => snapshot.pending,
        );
      })
      .toBe(true);
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Presence cannot hold this conversation");
    const start = performance.now();
    await composer.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(
          ({ event }) =>
            event?.content === "Presence cannot hold this conversation",
        ),
      )
      .toBe(true);
    app.report.measurements.push({
      sendWhilePresenceHeldMs: performance.now() - start,
    });
    expect(
      app.report.presenceSnapshots.some((snapshot) => snapshot.pending),
    ).toBe(true);
    const live = app.append(
      "primary",
      "alpha",
      "Incoming while presence is held",
    );
    await expect(page.locator(`[data-message-id="${live.id}"]`)).toBeVisible();
    expect(
      app.report.presenceSnapshots.some((snapshot) => snapshot.pending),
    ).toBe(true);
    app.relay.releasePresence();
    await expect(
      profile.getByRole("img", { name: "Presence: Active" }),
    ).toBeVisible();
    await expect(profile.locator(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    await expect(
      profile.getByRole("img", { name: "Alice Fixture avatar, online" }),
    ).toHaveCount(0);
    // Startup may skip busy setup. Keep real time: advancing only browser time
    // would expire its SSE heartbeat without advancing the broker's keepalive.
    await expect
      .poll(() => app.report.presencePublications.length, { timeout: 75000 })
      .toBeGreaterThan(0);
    expect(
      app.relay.requests.some(({ filters }) =>
        filters.some(
          (filter) =>
            filter.kinds.includes(20001) &&
            filter.limit === 0 &&
            filter.authors.length <= 256,
        ),
      ),
    ).toBe(true);
    await profile.screenshot({
      path: test.info().outputPath("presence-profile.png"),
    });
  } finally {
    app.relay.releasePresence();
  }
});

test("foreground send and cold channel entry remain available during a profile snapshot", async ({
  page,
  app,
}) => {
  // Hold preferences outside broker admission so roster warming cannot pre-load
  // Beta. Demand reads and presence still use their real owners and admission.
  const preferences = Promise.withResolvers();
  let preferencesPending = false;
  await page.route("**/sidebar-preferences", async (route) => {
    preferencesPending = true;
    await preferences.promise;
    await route.fallback();
  });
  app.relay.holdPresence();
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await settle(page);
  try {
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    const profile = page.getByRole("region", { name: "Profile details" });
    await expect(profile).toBeVisible();
    await expect
      .poll(() => {
        for (const pending of app.pending.splice(0)) pending.release();
        return app.report.presenceSnapshots.some(({ pending }) => pending);
      })
      .toBe(true);
    await settle(page);
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Measured foreground publication");
    const start = performance.now();
    await composer.press("Enter");
    await expect
      .poll(
        () =>
          app.report.publications.some(
            ({ event }) => event.content === "Measured foreground publication",
          ),
        { intervals: [10] },
      )
      .toBe(true);
    const sendMs = performance.now() - start;
    expect(app.report.presenceSnapshots.some(({ pending }) => pending)).toBe(
      true,
    );
    const betaHeads = () =>
      app.report.queries.filter(
        ({ filter }) =>
          filter.kinds?.includes(9) &&
          filter.top_level === true &&
          filter["#h"]?.includes("beta") &&
          filter.until === undefined,
      );
    await expect.poll(() => preferencesPending).toBe(true);
    expect(betaHeads()).toHaveLength(0);
    const visibleMs = await page.locator('[data-channel-id="beta"]').evaluate(
      async (button, ids) => {
        const start = performance.now();
        button.click();
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("cold channel did not paint")),
            5000,
          );
          const check = () => {
            const history = document.querySelector(
              '[aria-label="Channel message history"]',
            );
            const bounds = history?.getBoundingClientRect();
            const visible =
              bounds &&
              [...history.querySelectorAll("[data-message-id]")].some((row) => {
                const rect = row.getBoundingClientRect();
                return (
                  ids.includes(row.dataset.messageId) &&
                  rect.height > 0 &&
                  rect.bottom > bounds.top &&
                  rect.top < bounds.bottom
                );
              });
            if (
              !visible ||
              !document.querySelector(
                '[role="textbox"][aria-label="Message #Beta"]',
              )
            )
              return requestAnimationFrame(check);
            requestAnimationFrame(() => {
              clearTimeout(deadline);
              resolve();
            });
          };
          requestAnimationFrame(check);
        });
        return performance.now() - start;
      },
      app.histories.get("primary/beta").map(({ id }) => id),
    );
    expect(betaHeads().length).toBeGreaterThan(0);
    // Closing the contextual profile may abort optional work; do not require
    // an unnecessary snapshot to survive navigation just to satisfy this test.
    app.report.measurements.push({
      sendMs,
      coldVisibleMs: visibleMs,
      note: "send includes automation/polling; cold uses browser click-to-paint clock",
    });
  } finally {
    preferences.resolve();
    app.relay.releasePresence();
  }
});

test.describe("human message bylines omit presence", () => {
  test.use({ threadUnread: true, historyCounts: { alpha: 2, beta: 1 } });
  test("timeline and thread omit badges while the profile retains presence", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await settle(page);
    const timeline = page.locator("[data-channel-timeline]");
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    await timeline
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const thread = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(
      thread.getByText("Unread reply 0", { exact: true }),
    ).toBeVisible();
    await expect(
      timeline
        .getByRole("button", { name: "View Alice Fixture profile" })
        .first()
        .locator(".buzz-avatar-status"),
    ).not.toHaveAttribute("data-status");
    await expect(
      thread
        .getByRole("button", { name: "View Alice Fixture profile" })
        .first()
        .locator(".buzz-avatar-status"),
    ).not.toHaveAttribute("data-status");
    await thread
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    const profile = page.getByRole("region", { name: "Profile details" });
    // Human bylines do not demand presence; opening the profile starts that read.
    await expect(
      profile.getByRole("img", { name: "Presence: Active" }),
    ).toBeVisible();
    app.presence("away");
    await expect(
      profile.getByRole("img", { name: "Presence: Away" }),
    ).toBeVisible();
    expect(
      app.report.presenceSnapshots.some((snapshot) =>
        snapshot.filter.authors.includes(root.pubkey),
      ),
    ).toBe(true);
    await expect(profile.locator(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "away",
    );
    await expect(
      profile.getByRole("img", { name: "Alice Fixture avatar, online" }),
    ).toHaveCount(0);
    expect(
      app.relay.requests.some(({ filters }) =>
        filters.some(
          (filter) =>
            filter.kinds.includes(20001) &&
            filter.limit === 0 &&
            filter.authors.length <= 256,
        ),
      ),
    ).toBe(true);
  });
});

test("real same-origin windows queue one publisher and transfer its Web Lock on close", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  const presenceLocks = (target) =>
    target.evaluate(async () => {
      const locks = await navigator.locks.query();
      const select = (entries) =>
        entries.filter(({ name }) => name.startsWith("buzz-presence:"));
      return { held: select(locks.held), pending: select(locks.pending) };
    });
  await expect
    .poll(async () => (await presenceLocks(page)).held.length)
    .toBe(1);
  const owner = (await presenceLocks(page)).held[0];
  const second = await context.newPage();
  const pageErrors = app.watchPageErrors(second);
  const errors = [];
  second.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  try {
    await open(second, app);
    await expect
      .poll(async () => (await presenceLocks(second)).pending.length)
      .toBe(1);
    const both = await presenceLocks(second);
    expect(both.held).toHaveLength(1);
    expect(both.held[0].clientId).toBe(owner.clientId);
    expect(both.pending[0].name).toBe(owner.name);
    // A choice in the non-owner window must reach the holder before handoff.
    await second
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await second.getByRole("button", { name: /^Availability:/ }).click();
    await second
      .getByRole("menuitemradio", { name: "Offline", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: "Your status: Offline" }),
    ).toBeVisible();
    await expect
      .poll(() => app.report.presencePublications.at(-1)?.event.content)
      .toBe("offline");
    await expect
      .poll(async () => (await presenceLocks(second)).pending.length)
      .toBe(1);
    const offlineLocks = await presenceLocks(second);
    const firstHolds = offlineLocks.held[0].clientId === owner.clientId;
    const successor = offlineLocks.pending[0].clientId;
    const remaining = firstHolds ? second : page;
    const before = app.report.presencePublications.length;
    await (firstHolds ? page : second).close();
    await expect
      .poll(async () => (await presenceLocks(remaining)).held[0]?.clientId)
      .toBe(successor);
    expect((await presenceLocks(remaining)).pending).toHaveLength(0);
    await expect
      .poll(() => app.report.presencePublications.length, { timeout: 75000 })
      .toBeGreaterThan(before);
    expect(app.report.presencePublications.at(-1).event.content).toBe(
      "offline",
    );
    expect([...pageErrors.unexplained(), ...errors]).toEqual([]);
    app.report.measurements.push({
      publisherLockHandoff: { owner: owner.clientId, successor },
    });
  } finally {
    await second.close();
  }
});

test("presence becomes usable during held HTTP work and unfinished subscription setup", async ({
  page,
  app,
}) => {
  app.relay.holdEose("alpha");
  app.relay.holdUnread();
  const snapshotStart = Promise.withResolvers();
  await page.route("**/presence-snapshot", async (route) => {
    await snapshotStart.promise;
    await route.fallback();
  });
  const receipts = [];
  page.on("response", async (response) => {
    if (response.url().endsWith("/stream-presence"))
      receipts.push(await response.json());
  });
  try {
    await open(page, app);
    await expect
      .poll(() => app.report.unreadHolds.some((hold) => hold.pending))
      .toBe(true);
    await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    snapshotStart.resolve(); // Begin broker dispatch only after ordinary HTTP is held.
    await expect
      .poll(() => receipts.some(({ accepted }) => accepted === true))
      .toBe(true);
    await expect(
      page
        .getByRole("region", { name: "Profile details" })
        .getByRole("img", { name: "Presence: Active" })
        .first(),
    ).toBeVisible();
    expect(app.report.unreadHolds.some((hold) => hold.pending)).toBe(true);
    expect(
      app.report.wireFrames.some(
        ([kind, id]) =>
          kind === "EOSE" &&
          app.relay.requests.some(
            (req) => req.id === id && req.routes.includes("alpha"),
          ),
      ),
    ).toBe(false);
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Presence and chat during startup");
    await composer.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(
          ({ event }) => event.content === "Presence and chat during startup",
        ),
      )
      .toBe(true);
    expect(app.report.unreadHolds.some((hold) => hold.pending)).toBe(true);
    expect(
      app.report.presencePublications.some(
        ({ event }) => event.content === "online",
      ),
    ).toBe(true);
  } finally {
    snapshotStart.resolve();
    app.relay.releaseUnread();
    app.relay.releaseEose("alpha");
  }
});

// Real account controls -> shared activity -> retained session -> production
// broker -> authenticated socket; real localStorage survives app reconstruction.
test("profile trigger stays transparent through hover, press, and open menu", async ({
  page,
  app,
}) => {
  await open(page, app);
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    await trigger.hover();
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.down();
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.up();
    await page.mouse.move(1, 1);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
});

test("avatar choices publish through the existing socket and persist across reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const avatar = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("My presence follows the shared directory");
  await composer.press("Enter");
  const ownRow = page
    .locator("[data-message-id]")
    .filter({ hasText: "My presence follows the shared directory" });
  await expect(ownRow).toBeVisible();
  const ownBadge = ownRow.locator(".buzz-avatar-status");
  const badge = avatar.locator(".buzz-avatar-status-dot");
  const account = page.getByRole("menu", { name: "Fixture Reader" });
  const published = (status) =>
    app.report.presencePublications.filter(
      ({ event }) => event.content === status,
    ).length;
  await expect(
    avatar.getByRole("img", { name: "Your status: Online" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      avatar.locator(".buzz-avatar").evaluate(async (element) => {
        const mask = getComputedStyle(element).maskImage;
        const image = new Image();
        image.src = mask.slice(4, -1).replace(/^["']|["']$/g, "");
        try {
          await image.decode();
          return image.naturalWidth > 0;
        } catch {
          return false;
        }
      }),
    )
    .toBe(true);
  await expect(badge).toHaveCSS("background-image", "none");
  await expect(badge).toHaveCSS("box-shadow", "none");
  await expect(badge).toHaveCSS("background-color", "rgb(33, 131, 88)");
  await avatar.screenshot({
    path: test.info().outputPath("avatar-online.png"),
  });
  await avatar.click();
  await expect(
    page.getByRole("button", { name: "Availability: Online", exact: true }),
  ).toHaveCSS("color", "rgb(43, 154, 102)");
  await page.getByRole("button", { name: /^Availability:/ }).click();
  const attempts = [];
  const recordPresence = async (response) => {
    if (response.url().endsWith("/stream-presence"))
      attempts.push(await response.json());
  };
  page.on("response", recordPresence);
  const commandedAt = performance.now();
  const pendingPublication = Promise.withResolvers();
  const releasePublication = Promise.withResolvers();
  await page.route("**/stream-presence", async (route) => {
    pendingPublication.resolve();
    await releasePublication.promise;
    await route.continue();
  });
  try {
    await page
      .getByRole("menuitemradio", { name: "Away", exact: true })
      .click();
    await pendingPublication.promise;
    await expect(
      page
        .getByRole("status", { name: "" })
        .filter({ hasText: "Updating to away" }),
    ).toBeVisible();
    await expect(
      avatar.getByRole("img", { name: "Your status: Online" }),
    ).toBeVisible();
    await expect(ownBadge).not.toHaveAttribute("data-status");
    await expect(
      page.getByRole("menuitemradio", { name: "Online", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("menuitemradio", { name: "Away", exact: true }),
    ).not.toBeChecked();
  } finally {
    releasePublication.resolve();
  }
  await expect(
    avatar.getByRole("img", { name: "Your status: Away" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByText("Updating to away…", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitemradio", { name: "Away", exact: true }),
  ).toBeChecked();
  await page.unroute("**/stream-presence");
  page.off("response", recordPresence);
  const sent = app.report.presencePublications.filter(
    ({ community }) => community === "primary",
  );
  app.report.measurements.push({
    presenceCommandToVisibleMs: performance.now() - commandedAt,
    presenceSendGapMs: sent.at(-1).at - sent.at(-2).at,
    presenceAttempts: attempts,
    note: "includes the explicit pending-UI assertion gate and browser automation",
  });
  await expect(badge).toHaveCSS("background-color", "rgb(255, 186, 24)");
  await expect(ownBadge).not.toHaveAttribute("data-status");
  await expect
    .poll(() =>
      badge.evaluate((element) => getComputedStyle(element, "::after").content),
    )
    .toBe("none");
  await expect(
    page.getByRole("button", { name: "Availability: Away", exact: true }),
  ).toHaveCSS("color", "rgb(79, 52, 34)");
  await expect(badge).toHaveCSS("background-image", "none");
  await expect(badge).toHaveCSS("box-shadow", "none");
  await avatar.screenshot({ path: test.info().outputPath("avatar-away.png") });
  await expect.poll(() => published("away")).toBeGreaterThan(0);
  const editor = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await editor.click();
  await editor.fill("Still away while typing");
  await expect(
    avatar.getByRole("img", { name: "Your status: Away" }),
  ).toBeVisible();
  await avatar.click();
  await page.getByRole("button", { name: /^Availability:/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Offline", exact: true })
    .click();
  await expect.poll(() => published("offline")).toBeGreaterThan(0);
  await expect(ownBadge).not.toHaveAttribute("data-status");
  await page.reload();
  await expect(
    avatar.getByRole("img", { name: "Your status: Offline" }),
  ).toBeVisible();
  await expect(badge).toHaveCSS("background-color", "rgb(128, 128, 128)");
  await expect(badge).toHaveCSS("background-image", "none");
  await expect(badge).toHaveCSS("box-shadow", "none");
  await avatar.screenshot({
    path: test.info().outputPath("avatar-offline.png"),
  });
  await avatar.click();
  await page.getByRole("button", { name: /^Availability:/ }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Offline", exact: true }),
  ).toBeChecked();
  const before = published("online");
  await page
    .getByRole("menuitemradio", { name: "Online", exact: true })
    .click();
  await expect(
    avatar.getByRole("img", { name: "Your status: Online" }),
  ).toBeVisible();
  await expect.poll(() => published("online")).toBeGreaterThan(before);
  await account.screenshot({
    path: test.info().outputPath("presence-controls.png"),
  });
});
