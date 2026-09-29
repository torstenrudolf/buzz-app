import { test, expect } from "./fixture.mjs";
import { open, end, settle } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  exactMessages: true,
  historyCounts: { alpha: 103, beta: 0 },
});
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });
const target = (app, id = app.exact.target.id) => ({
  version: 1,
  kind: "conversation",
  channelId: "alpha",
  messageId: id,
  scope: {
    viewer: app.viewer,
    communityOrigin: "https://primary.example",
  },
  threadRootId: "f".repeat(64),
});
const status = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot().status);
async function openTarget(page, value) {
  return page.evaluate((value) => window.fixtureNavigation.open(value), value);
}

test("old root and reply beyond the first thread page open exactly; reclick and Back reveal again", async ({
  page,
  app,
}) => {
  await open(page, app);
  const initialHeadQueries = app.report.queries.filter(
    (q) => q.filter.top_level,
  ).length;
  const head = app.report.queries.find(
    ({ community, filter }) =>
      community === "primary" &&
      filter.top_level &&
      filter["#h"].includes("alpha"),
  );
  expect(
    app.histories.get("primary/alpha").at(-head.filter.limit).created_at,
    "the exact reply predates the initial channel window",
  ).toBeGreaterThan(app.exact.target.created_at);
  // This navigation fixture deliberately registers a catch-all panel first.
  // Disable it before exercising the actual Profiles provider.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Notes fixture", exact: true })
    .click();
  for (const [mode, id] of [
    ["cold root", app.exact.root.id],
    ["cold reply", app.exact.target.id],
    ["warm reply", app.exact.target.id],
  ]) {
    const start = performance.now();
    expect(await openTarget(page, target(app, id))).toEqual({
      status: "opened",
    });
    app.report.measurements.push({
      mode,
      clickToOpenedMs: performance.now() - start,
    });
    const row = thread(page).locator(`[data-message-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
    expect(await status(page)).toBe("opened");
    if (id === app.exact.target.id) {
      await expect(row).toContainText("Exact reply edited");
      await expect(
        row.locator("strong").filter({ hasText: "Exact reply edited" }),
      ).toHaveText("Exact reply edited");
      await expect(
        row.getByRole("button", {
          name: "View Alice Fixture profile",
          exact: true,
        }),
      ).toHaveCount(0); // Edited-body names cannot inherit original signed recipients.
      await expect(thread(page).locator("[data-message-id]")).toHaveCount(81);
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    }
  }
  expect(app.report.queries.filter((q) => q.filter.top_level).length).toBe(
    initialHeadQueries,
  );
  expect(app.report.queries.some((q) => q.filter.depth_limit)).toBe(true);
  expect(
    app.report.queries.some((q) => q.filter.thread_cursor !== undefined),
    "the exact reply requires a second thread page",
  ).toBe(true);
  expect(app.report.queries.filter((q) => q.filter.until)).toHaveLength(0);
  // Settings temporarily takes the rail without disposing the routed thread.
  const threadElement = page.locator('[aria-label="Thread"]');
  await threadElement.evaluate((element) => {
    window.retainedSettingsThread = element;
  });
  const position = await thread(page).evaluate((element) => element.scrollTop);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(threadElement).toBeHidden();
  await expect(threadElement.locator("..")).toHaveAttribute("inert", "");
  // Hidden retained content cannot be focused even though its layout is kept.
  await threadElement
    .locator('[aria-label="Thread messages"]')
    .evaluate((element) => element.focus());
  await expect(
    page.getByRole("button", { name: "Close channel settings" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  expect(
    await threadElement.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Close channel settings" }).click();
  await expect(threadElement).toBeVisible();
  expect(
    await threadElement.evaluate(
      (element) => element === window.retainedSettingsThread,
    ),
  ).toBe(true);
  await expect
    .poll(() => thread(page).evaluate((element) => element.scrollTop))
    .toBe(position);
  // Use an unedited reply to exercise exact mention/profile identity plumbing.
  expect(
    await openTarget(page, target(app, app.exact.replies.at(-2).id)),
  ).toEqual({ status: "opened" });
  const mention = thread(page)
    .locator(`[data-message-id="${app.exact.replies.at(-2).id}"]`)
    .getByRole("button", {
      name: "View Alice Fixture profile",
      exact: true,
    });
  await mention.click();
  await expect(
    page.getByRole("region", { name: "Profile details" }),
  ).toBeVisible();
  const profile = page.locator('[aria-label="Profile details"]');
  await profile.evaluate((element) => {
    window.retainedSettingsProfile = element;
  });
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(profile).toBeHidden();
  await page.getByRole("button", { name: "Close channel settings" }).click();
  await expect(profile).toBeVisible();
  expect(
    await profile.evaluate(
      (element) => element === window.retainedSettingsProfile,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Close channel panel", exact: true })
    .click();
  // Opening a panel retires the navigation-owned thread so the rail continues
  // to hold one surface. A fresh navigation can open another exact target.
  await expect(thread(page)).toHaveCount(0);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  await expect.poll(() => status(page)).toBe("opened");
});

test("loaded virtual rows reveal per attempt without thread reads or live-update focus theft", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  const id = app.histories.get("primary/alpha").at(-18).id;
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = performance.now();
    expect(await openTarget(page, target(app, id))).toEqual({
      status: "opened",
    });
    const row = history.locator(`[data-message-id="${id}"]`);
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    app.report.measurements.push({
      mode: `loaded timeline attempt ${attempt}`,
      clickToOpenedMs: performance.now() - start,
    });
    await composer.focus();
    await end(page);
  }
  expect(app.report.queries.filter((q) => q.filter.depth_limit)).toHaveLength(
    0,
  );
  await expect(thread(page)).toHaveCount(0);
  // Successful exact navigation retains its target ID. Detach after reveal;
  // live arrivals must count without treating that retained ID as pending.
  await history.hover();
  await page.mouse.wheel(0, -500);
  await expect
    .poll(() =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeGreaterThan(80);
  const first = app.append("primary", "alpha", "First detached arrival");
  const jump = history.locator("button[data-jump-to-latest]");
  await expect(jump).toHaveAccessibleName("1 new message");
  await jump.focus();
  await page.keyboard.press("Space");
  await expect(history).toBeFocused();
  await expect(
    history.locator(`[data-message-id="${first.id}"]`),
  ).toBeInViewport();
  await history.hover();
  await page.mouse.wheel(0, -500);
  await expect
    .poll(() =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeGreaterThan(80);
  app.append("primary", "alpha", "Second detached arrival");
  await expect(jump).toHaveAccessibleName("1 new message");
  await jump.focus();
  await page.keyboard.press("Enter");
  await expect(history).toBeFocused();
  await expect(jump).toHaveCount(0);
  await composer.focus();
  app.append("primary", "alpha", "Live after exact timeline reveal");
  await expect(history).toContainText("Live after exact timeline reveal");
  await expect(composer).toBeFocused();
});

test("an accessible exact reply stays visible without its root or a thread composer", async ({
  page,
  app,
}) => {
  app.histories.set(
    "primary/alpha",
    app.histories
      .get("primary/alpha")
      .filter((event) => event.id !== app.exact.root.id),
  );
  await open(page, app);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await expect(
    thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  await expect(
    thread(page).getByText("Original message unavailable."),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

// Real browsers own focus when a keyed row is removed and mounted under late ancestry.
const traversalTest = test.extend({ productionBroker: true, readState: true });
for (const nested of [false, true])
  traversalTest.describe(nested ? "late ancestry" : "direct ancestry", () => {
    traversalTest.use({ exactMessages: nested ? "nested" : true });
    for (const moveFocus of [false, true])
      traversalTest(
        `exact ${nested ? "nested" : "direct"} reply reveals before slow surrounding traversal and ${moveFocus ? "preserves moved focus" : "retains target focus"} afterwards`,
        async ({ page, app }) => {
          await open(page, app);
          let release;
          const held = new Promise((resolve) => {
            release = resolve;
          });
          let intercepted;
          const seen = new Promise((resolve) => {
            intercepted = resolve;
          });
          let first = true;
          await page.route("**/api/relay/**/query", async (route) => {
            if (
              !first ||
              !route
                .request()
                .postDataJSON()
                .some((filter) => filter.depth_limit)
            )
              return route.continue();
            first = false;
            intercepted();
            await held;
            await route.continue().catch(() => {});
          });
          const row = thread(page).locator(
            `[data-message-id="${app.exact.target.id}"]`,
          );
          const close = page.getByRole("button", {
            name: "Close thread",
            exact: true,
          });
          let originalRow;
          try {
            await page.evaluate((value) => {
              window.exactResult = window.fixtureNavigation.open(value);
            }, target(app));
            await seen;
            await expect.poll(() => status(page)).toBe("opened");
            await expect(row).toBeFocused();
            await expect(row).toBeInViewport();
            if (nested)
              await expect(
                thread(page).getByText(
                  "Earlier reply unavailable in loaded history.",
                  { exact: true },
                ),
              ).toBeVisible();
            originalRow = await row.elementHandle();
            if (moveFocus) await close.focus();
          } finally {
            release();
          }
          try {
            await expect(thread(page).locator("[data-message-id]")).toHaveCount(
              81,
            );
            if (nested)
              await expect(
                thread(page).getByText(
                  "Earlier reply unavailable in loaded history.",
                  { exact: true },
                ),
              ).toHaveCount(0);
            await expect(row).toBeInViewport();
            expect(
              await row.evaluate(
                (element, original) => element === original,
                originalRow,
              ),
            ).toBe(!nested);
            await expect(moveFocus ? close : row).toBeFocused();
            if (nested && !moveFocus) {
              // A later arrival cannot close or refocus an already revealed branch.
              await close.focus();
              app.reply(app.exact.root.id);
              await expect(
                thread(page).getByText("New peer reply", { exact: true }),
              ).toBeVisible();
              await expect(row).toBeVisible();
              await expect(close).toBeFocused();
              await expect(
                page.getByRole("button", { name: "Hide replies", exact: true }),
              ).toHaveCount(0);
            }
          } finally {
            await originalRow?.dispose();
          }
        },
      );
  });

test("unknown target fails without channel-head success and retries in the same visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  expect(await openTarget(page, target(app, "e".repeat(64)))).toEqual({
    status: "failed",
    reason: "not-found",
  });
  await expect(
    page.getByRole("heading", { name: "This destination couldn’t open" }),
  ).toBeVisible();
  const visit = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  await page
    .getByRole("button", { name: "Retry navigation", exact: true })
    .click();
  await expect.poll(() => status(page)).toBe("failed");
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
  ).toBe(visit);
  await expect(thread(page).locator("[data-message-id]")).toHaveCount(0);
});

test("superseding a held exact read cancels it; a late response cannot steal focus or complete the next visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release;
  let intercepted;
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters?.some((filter) => filter.ids?.includes(app.exact.target.id)))
      return route.continue();
    intercepted();
    await held;
    await route.fulfill({ json: [app.exact.target] }).catch(() => {});
  });
  await page.evaluate((value) => {
    window.exactResult = window.fixtureNavigation.open(value);
  }, target(app));
  await seen;
  expect(await status(page)).toBe("opening");
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  expect(await page.evaluate(() => window.exactResult)).toEqual({
    status: "superseded",
  });
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.focus();
  release();
  await expect(composer).toBeFocused();
  await expect(thread(page)).toHaveCount(0);
  await expect.poll(() => status(page)).toBe("opened");
});

for (const selected of ["reply", "root"]) {
  test(`same-scope replacement waits for fresh membership before reopening the exact ${selected}`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const id = selected === "root" ? app.exact.root.id : app.exact.target.id;
    const destination = {
      ...target(app, id),
      ...(selected === "root" ? { threadRootId: id } : {}),
    };
    let release;
    let intercepted;
    const seen = new Promise((resolve) => {
      intercepted = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let releaseRoster;
    const roster = new Promise((resolve) => {
      releaseRoster = resolve;
    });
    let reconnecting = false;
    let rosterRequested = false;
    let exactReads = 0;
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (
        reconnecting &&
        filters?.some((filter) => filter.kinds?.includes(39002))
      ) {
        rosterRequested = true;
        await roster;
        return route.continue();
      }
      if (!filters?.some((filter) => filter.ids?.includes(id)))
        return route.continue();
      exactReads++;
      if (exactReads !== 1) return route.continue();
      intercepted();
      await held;
      await route
        .fulfill({
          json: [selected === "root" ? app.exact.root : app.exact.target],
        })
        .catch(() => {});
    });
    try {
      await page.evaluate((value) => {
        window.exactResult = window.fixtureNavigation.open(value);
      }, destination);
      await seen;
      const generation = await page.evaluate(() => {
        const generation = window.fixtureRelay.snapshot().generation;
        window.fixtureRelay.disconnect();
        return generation;
      });
      await expect(thread(page)).toHaveCount(0);
      reconnecting = true;
      await page.evaluate(() => window.fixtureRelay.retry());
      release();
      await expect.poll(() => rosterRequested).toBe(true);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const connection = window.fixtureRelay.snapshot();
            return (
              connection.status === "ready" &&
              connection.session.channels.get("alpha")?.cached === true
            );
          }),
        )
        .toBe(true);
      await settle(page);
      expect(await status(page)).toBe("opening");
      await expect(thread(page)).toHaveCount(0);
      expect(exactReads).toBe(1);
      releaseRoster();
      const row = thread(page).locator(`[data-message-id="${id}"]`);
      // Opening a root is ordinary thread navigation (bottom-follow), not an
      // exact-row reveal. Replies must still receive exact-message focus.
      if (selected === "root") await expect(row).toBeAttached();
      else await expect(row).toBeFocused();
      expect(
        await page.evaluate(() => window.fixtureRelay.snapshot().generation),
      ).toBeGreaterThan(generation);
      expect(await page.evaluate(() => window.exactResult)).toEqual({
        status: "opened",
      });
    } finally {
      release();
      releaseRoster();
    }
  });
}

test("post-success membership loss removes the thread and live updates do not snap it back to the target", async ({
  page,
  app,
}) => {
  await open(page, app);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  const region = thread(page);
  const channelButton = page.getByRole("button", {
    name: "Close thread",
    exact: true,
  });
  await channelButton.focus();
  const before = await region.evaluate((element) => element.scrollTop);
  app.edit(
    "primary",
    "alpha",
    { ...app.exact.target, created_at: app.exact.target.created_at + 10 },
    "Live edited exact reply",
  );
  await expect(region).toContainText("Live edited exact reply");
  await expect(channelButton).toBeFocused();
  expect(await region.evaluate((element) => element.scrollTop)).toBe(before);
  app.omitChannel("alpha");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  await expect(region).toHaveCount(0);
  await expect(
    page.locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toHaveCount(0);
});

const readingTest = test.extend({ tallMessages: true });
readingTest(
  "exact thread navigation leaves the ordinary channel reading anchor unchanged",
  async ({ page, app }, testInfo) => {
    const { settle, wheel, anchor, expectAnchor } = await import(
      "./timeline.mjs"
    );
    await open(page, app);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    // Keep writer evidence for the Linux-only displacement: ordinary Playwright
    // snapshots show the resulting offset, but not who requested the scroll.
    // These wrappers forward unchanged arguments; they never correct position.
    await history.evaluate((element) => {
      const records = [];
      window.navigationScrollTrace = records;
      const record = (kind, detail = {}) => {
        const bounds = element.getBoundingClientRect();
        const rows = Array.from(element.querySelectorAll("[data-message-id]"));
        const visible = rows.filter((row) => {
          const box = row.getBoundingClientRect();
          return box.bottom > bounds.top && box.top < bounds.bottom;
        });
        if (records.length === 500) records.shift();
        records.push({
          time: performance.now(),
          kind,
          ...detail,
          top: element.scrollTop,
          height: element.scrollHeight,
          viewport: [element.clientWidth, element.clientHeight],
          list: element.querySelector("ol")?.style.height,
          rows: visible.map((row) => ({
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - bounds.top,
          })),
        });
      };
      const prototype = Element.prototype;
      const scrollTop = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
      Object.defineProperty(prototype, "scrollTop", {
        ...scrollTop,
        set(value) {
          if (this === element)
            record("scrollTop:before", { value, stack: new Error().stack });
          scrollTop.set.call(this, value);
          if (this === element) record("scrollTop:after");
        },
      });
      for (const name of ["scroll", "scrollTo", "scrollBy"]) {
        const original = prototype[name];
        prototype[name] = function (...args) {
          if (this === element)
            record(`${name}:before`, { args, stack: new Error().stack });
          const result = original.apply(this, args);
          if (this === element) record(`${name}:after`);
          return result;
        };
      }
      for (const name of ["wheel", "scroll", "scrollend"]) {
        element.addEventListener(
          name,
          (event) =>
            record(name, { deltaY: event.deltaY, trusted: event.isTrusted }),
          { passive: true },
        );
      }
      const resize = new ResizeObserver(() => record("resize"));
      resize.observe(element);
      resize.observe(element.querySelector("ol"));
      record("installed");
    });
    try {
      await history.hover();
      await wheel(page, -650);
      const reading = await anchor(page);
      expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(history).toBeVisible();
      await settle(page);
      await expectAnchor(page, reading);
    } finally {
      await testInfo.attach("navigation-scroll-writers", {
        body: JSON.stringify(
          await page.evaluate(() => window.navigationScrollTrace),
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
  },
);

const readTest = test.extend({ productionBroker: true, readState: true });
test.describe("fractional row geometry", () => {
  test.use({ historyCounts: { alpha: 12, beta: 1 }, exactMessages: false });
  test("bottom following keeps the final row fully visible after fractional reflow", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const row = history.locator(
      `[data-message-id="${app.histories.get("primary/alpha").at(-1).id}"]`,
    );
    // Text scaling and wrapping can produce fractional heights. Make the next
    // measurement fractional explicitly, independent of platform font metrics.
    const before = await history
      .locator("ol")
      .evaluate((e) => e.getBoundingClientRect().height);
    await row.evaluate((e, height) => {
      e.style.paddingBottom = `${Math.ceil(height) - height + 0.75}px`;
    }, before);
    await expect
      .poll(() =>
        history.locator("ol").evaluate((e) => e.getBoundingClientRect().height),
      )
      .toBe(Math.ceil(before) + 0.75);
    await expect
      .poll(() =>
        row.evaluate((e) => {
          const viewport = e
            .closest("[data-channel-timeline]")
            .getBoundingClientRect();
          const box = e.getBoundingClientRect();
          return box.top >= viewport.top && box.bottom <= viewport.bottom;
        }),
      )
      .toBe(true);
  });
});

readTest(
  "exact reveal uses ordinary dwell rather than marking read at open",
  async ({ page, app }) => {
    await open(page, app);
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let intercepted;
    const seen = new Promise((resolve) => {
      intercepted = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.depth_limit)
      )
        return route.continue();
      intercepted();
      await held;
      await route.continue().catch(() => {});
    });
    const before = app.report.readPublications.length;
    try {
      expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
      await seen;
      expect(app.report.readPublications.length).toBe(before);
      await expect(
        thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
      ).toBeFocused();
    } finally {
      release();
    }
    await expect(thread(page).locator("[data-message-id]")).toHaveCount(81);
    await expect(
      thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
    ).toBeFocused();
    await expect
      .poll(() => app.report.readPublications.length)
      .toBeGreaterThan(before);
  },
);

// Browser-only: inert focus behavior and a retained-but-hidden panel's real layout.
readTest(
  "settings blocks reading and focus in a retained thread",
  async ({ page, app }) => {
    await page.clock.install();
    await open(page, app);
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .focus();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const before = app.report.readPublications.length;
    const row = page.locator(
      `[aria-label="Thread messages"] [data-message-id="${app.exact.target.id}"]`,
    );
    await row.focus();
    await expect(row).toBeFocused();
    // Programmatic opening deliberately does not focus the settings trigger first.
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .evaluate((element) => element.click());
    await expect(
      page.getByRole("complementary", {
        name: "Channel settings",
        exact: true,
      }),
    ).toBeVisible();
    await row.evaluate((element) => element.focus());
    await expect(row).not.toBeFocused();
    await page.keyboard.press("Tab");
    expect(
      await page
        .locator('[aria-label="Thread"]')
        .evaluate((element) => element.contains(document.activeElement)),
    ).toBe(false);
    await page.clock.runFor(10000);
    expect(app.report.readPublications.length).toBe(before);
    await page
      .getByRole("button", { name: "Close channel settings", exact: true })
      .click();
    await row.focus();
    await expect(row).toBeFocused();
    await page.clock.resume();
    await expect
      .poll(() => app.report.readPublications.length)
      .toBeGreaterThan(before);
  },
);

// Paint compositing, unlike DOM visibility, includes descendant visibility overrides.
traversalTest(
  "settings suppresses revealed spoiler painting and restores the retained thread",
  async ({ page, app }) => {
    const child = app.append(
      "primary",
      "alpha",
      "||REVEALED SPOILER TEXT||",
      false,
      false,
      app.exact.root.id,
    );
    await open(page, app);
    expect(await openTarget(page, target(app, child.id))).toEqual({
      status: "opened",
    });
    const row = page.locator(
      `[aria-label="Thread messages"] [data-message-id="${child.id}"]`,
    );
    await row.getByRole("button", { name: "Reveal spoiler" }).click();
    await expect(row.locator('[data-revealed="true"]')).toHaveCount(1);
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    const settings = page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    const retained = row.locator("xpath=ancestor::*[@inert][1]");
    const actual = await settings.screenshot({ animations: "disabled" });
    await retained.evaluate((element) => {
      element.style.opacity = "0";
    });
    const fullyHidden = await settings.screenshot({ animations: "disabled" });
    await retained.evaluate((element) => {
      element.style.removeProperty("opacity");
    });
    expect(
      actual.equals(fullyHidden),
      "retained thread must not paint over settings",
    ).toBe(true);
    await page
      .getByRole("button", { name: "Close channel settings", exact: true })
      .click();
    await expect(
      row.getByText("REVEALED SPOILER TEXT", { exact: true }),
    ).toBeVisible();
    await expect(row.locator('[data-revealed="true"]')).toHaveCount(1);
  },
);

// Native focus and revealed markdown must survive live leaf/branch transitions.
for (const movedFocus of [false, true])
  traversalTest(
    `live child-count changes preserve reply state and ${movedFocus ? "deliberately moved" : "target"} focus`,
    async ({ page, app }) => {
      const parent = app.append(
        "primary",
        "alpha",
        "||PERSISTENT SPOILER||",
        false,
        true,
        app.exact.root.id,
      );
      await open(page, app);
      expect(await openTarget(page, target(app, parent.id))).toEqual({
        status: "opened",
      });
      const region = thread(page);
      await expect(region.locator("[data-message-id]")).toHaveCount(82);
      await expect(region.getByText("Loading thread…")).toHaveCount(0);
      const row = region.locator(`[data-message-id="${parent.id}"]`);
      await row.getByRole("button", { name: "Reveal spoiler" }).click();
      const original = await row.elementHandle();
      const close = page.getByRole("button", {
        name: "Close thread",
        exact: true,
      });
      const focusTarget = movedFocus ? close : row;
      await focusTarget.focus();
      const child = app.append(
        "primary",
        "alpha",
        "First live child",
        true,
        true,
        app.exact.root.id,
        parent.id,
      );
      const branch = row.locator("xpath=ancestor::*[@data-depth][1]");
      const expand = branch.getByRole("button", { name: /^View 1 reply/ });
      await expect(expand).toBeVisible();
      await expect(focusTarget).toBeFocused();
      expect(await row.evaluate((node, old) => node === old, original)).toBe(
        true,
      );
      await expect(row.locator('[data-revealed="true"]')).toHaveCount(1);
      await expand.click();
      await expect(
        region.getByText("First live child", { exact: true }),
      ).toBeVisible();
      // Opening moves focus intentionally; establish the owned/moved focus anew.
      await expect(
        region.locator(`[data-message-id="${child.id}"]`),
      ).toBeFocused();
      if (movedFocus) await focusTarget.focus();
      app.deleteTarget(child);
      await expect(
        region.getByText("First live child", { exact: true }),
      ).toHaveCount(0);
      await expect(
        branch.getByRole("button", { name: "Hide replies", exact: true }),
      ).toHaveCount(0);
      await expect(focusTarget).toBeFocused();
      expect(await row.evaluate((node, old) => node === old, original)).toBe(
        true,
      );
      await expect(row.locator('[data-revealed="true"]')).toHaveCount(1);
    },
  );

const liveTest = test.extend({ productionBroker: true });
liveTest(
  "stream repair retains thread rows, reading position and composer focus after exact opening",
  async ({ page, app }) => {
    await open(page, app);
    await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    const region = thread(page);
    await expect(region.locator("[data-message-id]")).toHaveCount(81);
    await expect(region.getByText("Loading thread…")).toHaveCount(0);
    const readingRow = region.locator(
      `[data-message-id="${app.exact.replies[40].id}"]`,
    );
    await readingRow.scrollIntoViewIfNeeded();
    await region.dispatchEvent("wheel", { deltaY: -1 });
    const composer = page.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await composer.fill("Preserve my thread draft");
    await settle(page);
    const before = await region.evaluate((element) => element.scrollTop);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let intercepted;
    const seen = new Promise((resolve) => {
      intercepted = resolve;
    });
    let first = true;
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !first ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.ids?.includes(app.exact.target.id))
      )
        return route.continue();
      first = false;
      intercepted();
      await held;
      await route.continue().catch(() => {});
    });
    app.relay.disconnect("primary");
    await seen;
    await expect(region.locator("[data-message-id]")).toHaveCount(81);
    await expect(composer).toBeFocused();
    expect(await region.evaluate((element) => element.scrollTop)).toBeCloseTo(
      before,
      0,
    );
    release();
    await expect(region.getByText("Loading thread…")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty(
      "value",
      "Preserve my thread draft",
    );
    expect(await region.evaluate((element) => element.scrollTop)).toBeCloseTo(
      before,
      0,
    );
    await expect(readingRow).toBeInViewport();
  },
);

liveTest(
  "deleting the selected reply keeps valid thread context and exposes a local unavailable state",
  async ({ page, app }) => {
    await open(page, app);
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    const region = thread(page);
    await expect(region.locator("[data-message-id]")).toHaveCount(81);
    app.deleteTarget();
    await expect(
      region.locator(`[data-message-id="${app.exact.target.id}"]`),
    ).toHaveCount(0);
    await expect(
      region.locator(`[data-message-id="${app.exact.root.id}"]`),
    ).toBeAttached();
    await expect(region.locator("[data-message-id]")).toHaveCount(80);
    await expect(region).toBeFocused();
    await expect(region).toHaveAttribute("tabindex", "0");
    app.append(
      "primary",
      "alpha",
      "Reply after selected deletion",
      true,
      true,
      app.exact.root.id,
    );
    await expect(
      region.getByText("Reply after selected deletion", { exact: true }),
    ).toBeVisible();
    await expect(region).toHaveAttribute("tabindex", "0");
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(region).toBeFocused();
    await expect(
      region.getByText("Selected message unavailable."),
    ).toBeVisible();
    await expect(region.getByText("Original message unavailable.")).toHaveCount(
      0,
    );
    await expect(
      region.getByRole("button", { name: "Retry thread", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
  },
);
