import { test, expect } from "./fixture.mjs";
import { open, edge, settle } from "./timeline.mjs";

// These journeys cover real document boot, IndexedDB reload, React session
// replacement and DOM continuity. Failure/corruption matrices live in Vitest.
test.use({
  productionBroker: true,
  pluginFixtures: true,
  savedSidebar: true,
  historyCounts: { alpha: 1, beta: 40 },
});
const held = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function cached(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-channel-heads-v1", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["heads", "startup"]);
          const heads = tx.objectStore("heads").getAll();
          const startup = tx.objectStore("startup").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({ heads: heads.result, startup: startup.result });
          };
        };
      }),
  );
}
test("reload restores the selected conversation/groups before handshake and updates without replacing its DOM", async ({
  page,
  app,
}) => {
  const beta = app.histories.get("primary/beta");
  const last = beta.at(-1);
  beta[beta.length - 1] = app.sign({
    kind: 9,
    content: last.content,
    created_at: last.created_at,
    tags: [
      ...last.tags,
      [
        "imeta",
        "url https://image.test/startup.svg",
        "m image/svg+xml",
        "dim 640x400",
      ],
    ],
  });
  await page.route("https://image.test/startup.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="teal"/></svg>',
    }),
  );
  await open(page, app);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(history).toContainText("primary beta message 39");
  await expect(page.getByText("Work", { exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await composer.fill("Keep this draft");
  await expect
    .poll(async () =>
      (await cached(page)).heads.some((h) => h.channelId === "beta"),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await cached(page)).startup.some(
        (r) => r.data.preferences && r.data.discovery,
      ),
    )
    .toBe(true);
  const gate = held();
  let requested = false;
  await page.route("**/api/relay/*/session", async (route) => {
    requested = true;
    await gate.promise;
    await route.fallback();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => requested).toBe(true);
    await expect(history).toContainText("primary beta message 39");
    await expect(page.getByText("Work", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Loading your sidebar…", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Reconnecting…")).toHaveCount(0);
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveText("Keep this draft");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Unread channel visit expired" }),
    ).toHaveCount(0);
    const placeholder = history.locator(
      '[class*="attachmentImage"][aria-hidden="true"]',
    );
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toBeEmpty();
    await settle(page);
    const cachedImage = await placeholder.boundingBox();
    const cachedHistory = await history.boundingBox();
    const retained = await history.elementHandle();
    await page.evaluate(() => {
      window.startupFrames = [];
      window.startupObserving = true;
      const frame = () => {
        if (!window.startupObserving) return;
        const history = document.querySelector(
          '[aria-label="Channel message history"]',
        );
        window.startupFrames.push(
          history?.textContent?.includes("primary beta message 39") ?? false,
        );
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    gate.release();
    await expect(page.getByText("Reconnecting…")).toHaveCount(0);
    await expect(composer).toHaveText("Keep this draft");
    await expect(composer).toBeEditable();
    const image = history.getByRole("link", {
      name: "Open image attachment",
      exact: true,
    });
    await expect(image).toBeVisible();
    await settle(page);
    const liveImage = await image.boundingBox();
    const liveHistory = await history.boundingBox();
    expect(Math.abs(liveImage.height - cachedImage.height)).toBeLessThan(1);
    expect(Math.abs(liveImage.width - cachedImage.width)).toBeLessThan(1);
    expect(Math.abs(liveHistory.height - cachedHistory.height)).toBeLessThan(1);
    await expect
      .poll(() => retained.evaluate((node) => node.isConnected))
      .toBe(true);
    const frames = await page.evaluate(() => {
      window.startupObserving = false;
      return window.startupFrames;
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(Boolean)).toBe(true);
    await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
    const live = app.append("primary", "beta", "Live after cached promotion");
    await expect(
      history.locator(`[data-message-id="${live.id}"]`),
    ).toBeVisible();
    expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
    // Visible appended content can precede Virtua's final follow-to-bottom
    // measurement. Establish that layout before measuring a wheel distance.
    await settle(page);
    const olderReads = () =>
      app.report.queries.filter(
        ({ filter }) => filter["#h"]?.includes("beta") && filter.before_id,
      );
    const beforeOlder = olderReads().length;
    await edge(page, -1);
    await expect.poll(() => olderReads().length).toBeGreaterThan(beforeOlder);
    await expect.poll(() => app.pending.length).toBe(1);
    const older = app.pending.shift();
    expect(older.channel).toBe("beta");
    expect(
      older.events.some((event) =>
        event.content.startsWith("primary beta message 1\n"),
      ),
    ).toBe(true);
    await expect(
      history.getByRole("button", { name: "Loading older…", exact: true }),
    ).toBeVisible();
    older.release();
    await expect(
      history.getByRole("button", { name: "Loading older…", exact: true }),
    ).toHaveCount(0);
    await settle(page);
    await expect(history).toContainText("primary beta message 1");
    // A missed live event is learned only by the current session's explicit refresh.
    const missed = app.append(
      "primary",
      "beta",
      "Fetched by successor refresh",
      false,
    );
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await page.getByText("Diagnostics", { exact: true }).click();
    await page
      .getByRole("button", { name: "Refresh messages", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close channel settings", exact: true })
      .click();
    await settle(page);
    await edge(page, 1);
    await expect(
      history.locator(`[data-message-id="${missed.id}"]`),
    ).toBeAttached();
    expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
    await retained.dispose();
  } finally {
    gate.release();
  }
});

test("fresh roster omission removes cached conversation and its next-launch record", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(async () =>
      (await cached(page)).heads.some((h) => h.channelId === "alpha"),
    )
    .toBe(true);
  const gate = held();
  let requested = false;
  await page.route("**/api/relay/*/session", async (route) => {
    requested = true;
    await gate.promise;
    await route.fallback();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => requested).toBe(true);
    await expect(
      page.getByRole("region", { name: "Channel message history" }),
    ).toContainText("primary alpha message 0");
    app.omitChannel("alpha");
    gate.release();
    await expect(page.locator('[data-channel-id="alpha"]')).toHaveCount(0);
    await expect(
      page.getByText("primary alpha message 0", { exact: false }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const { heads, startup } = await cached(page);
        return (
          heads.every((head) => head.channelId !== "alpha") &&
          startup.every(
            (row) =>
              !(row.data.discovery?.events ?? []).some((event) =>
                event.tags.some(([key, id]) => key === "d" && id === "alpha"),
              ),
          )
        );
      })
      .toBe(true);
  } finally {
    gate.release();
  }
});

test("offline reload remains readable and recovers in place on the browser online signal", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(async () =>
      (await cached(page)).heads.some((h) => h.channelId === "alpha"),
    )
    .toBe(true);
  await page.route("**/api/relay/*/session", async (route) => {
    app.report.startupFailures ??= [];
    app.report.startupFailures.push(route.request().url());
    await route.fulfill({ status: 502, json: { error: "Fixture offline" } });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(history).toContainText("primary alpha message 0");
  await expect(
    page.getByRole("button", { name: "Retry connection", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeDisabled();
  const retained = await history.elementHandle();
  await page.unroute("**/api/relay/*/session");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeEditable();
  await expect(
    page.getByRole("button", { name: "Retry connection", exact: true }),
  ).toHaveCount(0);
  expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
  await retained.dispose();
});

for (const theme of ["light", "dark"]) {
  test(`document launch uses ${theme} background and a centered logo before React`, async ({
    page,
    app,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("buzz-appearance.v1", theme),
      theme,
    );
    const gate = held();
    let requested = false;
    await page.route("**/assets/*.js", async (route) => {
      requested = true;
      await gate.promise;
      await route.continue();
    });
    try {
      await page.goto(app.origin, { waitUntil: "commit" });
      await expect.poll(() => requested).toBe(true);
      const launch = page.getByRole("status", { name: "Opening Buzz" });
      await expect(launch).toBeVisible();
      await expect(launch).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(0, 0, 0)" : "rgb(245, 245, 246)",
      );
      await expect(launch.getByRole("img", { name: "Buzz" })).toHaveCSS(
        "filter",
        theme === "dark" ? "invert(1)" : "none",
      );
      const mark = await launch
        .getByRole("img", { name: "Buzz" })
        .boundingBox();
      const viewport = page.viewportSize();
      expect(
        Math.abs(mark.x + mark.width / 2 - viewport.width / 2),
      ).toBeLessThan(1);
      expect(
        Math.abs(mark.y + mark.height / 2 - viewport.height / 2),
      ).toBeLessThan(1);
    } finally {
      gate.release();
    }
    await expect(
      page.getByRole("status", { name: "Opening Buzz" }),
    ).toHaveCount(0);
  });
}

test.describe("personal sidebar startup", () => {
  test.use({ personalSidebar: true });
  test("keeps opted-in groups through cached launch and live promotion", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeEditable();
    const group = page.getByText("Personal work", { exact: true });
    await expect(group).toBeVisible();
    await expect
      .poll(async () =>
        (await cached(page)).startup.some(
          (r) => r.data.preferences?.data.groupSource === "personal",
        ),
      )
      .toBe(true);
    const gate = held();
    let requested = false;
    await page.route("**/api/relay/*/session", async (route) => {
      requested = true;
      await gate.promise;
      await route.fallback();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => requested).toBe(true);
      await expect(group).toBeVisible();
      await expect(page.getByText("Work", { exact: true })).toHaveCount(0);
      gate.release();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeEditable();
      await expect(group).toBeVisible();
      await expect
        .poll(async () =>
          (await cached(page)).startup.some(
            (r) => r.data.preferences?.data.groupSource === "personal",
          ),
        )
        .toBe(true);
    } finally {
      gate.release();
    }
  });
});

test.describe("populated device cache", () => {
  const channels = [
    "alpha",
    ...Array.from({ length: 63 }, (_, i) => `saved-${i}`),
  ];
  test.use({
    channelIds: channels,
    historyCounts: Object.fromEntries(channels.map((id) => [id, 20])),
  });
  test("selected conversation paints with 64 saved heads while handshake is held", async ({
    page,
    app,
  }, info) => {
    await open(page, app);
    await expect
      .poll(async () =>
        (await cached(page)).startup.some((r) => r.data.discovery),
      )
      .toBe(true);
    const input = app.startupCache();
    expect(input.heads).toHaveLength(64);
    expect(input.discovery).toHaveLength(128);
    await page.evaluate(async (input) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-channel-heads-v1", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["heads", "startup"], "readwrite");
        const request = tx.objectStore("startup").getAll();
        request.onsuccess = () => {
          const row = request.result[0];
          row.data.discovery.events = input.discovery;
          tx.objectStore("startup").put(row);
          for (const head of input.heads)
            tx.objectStore("heads").put({
              ...head,
              scope: row.key,
              key: `${row.key}:${head.channelId}`,
              bytes: JSON.stringify(head).length,
            });
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, input);
    await page.addInitScript(() => {
      window.startupMeasure = { loadingFrames: [], firstHistoryMs: null };
      const frame = () => {
        const body = document.body?.textContent ?? "";
        if (
          /Connecting to relay|Loading your sidebar|Loading channels/.test(body)
        )
          window.startupMeasure.loadingFrames.push(body);
        if (
          document
            .querySelector('[aria-label="Channel message history"]')
            ?.textContent?.includes("primary alpha message 19")
        ) {
          window.startupMeasure.firstHistoryMs = performance.now();
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const gate = held();
    let requested = false;
    await page.route("**/api/relay/*/session", async (route) => {
      requested = true;
      await gate.promise;
      await route.fallback();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => requested).toBe(true);
      await expect
        .poll(() => page.evaluate(() => window.startupMeasure.firstHistoryMs))
        .not.toBeNull();
      const measured = await page.evaluate(() => window.startupMeasure);
      expect(measured.loadingFrames).toEqual([]);
      const result = {
        engine: info.project.name,
        heads: input.heads.length,
        events: input.heads.reduce((n, h) => n + h.events.length, 0),
        discoveryEvents: input.discovery.length,
        bytes: JSON.stringify(input).length,
        firstHistoryMs: measured.firstHistoryMs,
      };
      console.log("STARTUP_SCALE", JSON.stringify(result));
      await info.attach("startup-scale.json", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
    } finally {
      gate.release();
    }
  });
});

test.describe("saved DM labels", () => {
  test.use({ dmLabels: true });
  test("restores the sidebar name even when the DM was never opened", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const dm = page.getByRole("button", { name: "Alice Fixture", exact: true });
    await expect(dm).toBeVisible();
    await expect
      .poll(async () =>
        (await cached(page)).startup.some((r) =>
          r.data.discovery?.profiles?.some(
            (p) => p.pubkey === app.participants[0],
          ),
        ),
      )
      .toBe(true);
    const gate = held();
    let requested = false;
    await page.route("**/api/relay/*/session", async (route) => {
      requested = true;
      await gate.promise;
      await route.fallback();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => requested).toBe(true);
      await expect(dm).toBeVisible();
      app.relay.holdProfiles(app.participants);
      gate.release();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeEditable();
      await expect(dm).toBeVisible();
    } finally {
      app.relay.releaseProfiles();
      gate.release();
    }
  });
});

test.describe("pending startup navigation", () => {
  test("waits for a conversation absent from the saved roster, then opens it live", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(async () =>
        (await cached(page)).startup.some((row) => row.data.discovery),
      )
      .toBe(true);
    // Model a device snapshot from before Beta was joined, without altering live authority.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-channel-heads-v1", 2);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("startup", "readwrite");
            const store = tx.objectStore("startup");
            const rows = store.getAll();
            rows.onsuccess = () => {
              for (const row of rows.result) {
                row.data.discovery.events = row.data.discovery.events.filter(
                  (event) =>
                    !event.tags.some(
                      ([key, value]) => key === "d" && value === "beta",
                    ),
                );
                store.put(row);
              }
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        }),
    );
    const gate = held();
    let requested = false;
    await page.route("**/api/relay/*/session", async (route) => {
      requested = true;
      await gate.promise;
      await route.fallback();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => requested).toBe(true);
      await expect(
        page.getByRole("button", { name: "Alpha", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Reconnecting…")).toHaveCount(0);
      await page.evaluate((viewer) => {
        window.startupNavigation = undefined;
        void window.fixtureNavigation
          .open({
            version: 1,
            kind: "conversation",
            channelId: "beta",
            scope: { viewer, communityOrigin: "https://primary.example" },
          })
          .then((result) => {
            window.startupNavigation = result;
          });
      }, app.viewer);
      await expect(
        page.getByText("Checking conversation access…", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => window.startupNavigation ?? null),
      ).toBeNull();
      gate.release();
      await expect(
        page.getByRole("textbox", { name: "Message #Beta", exact: true }),
      ).toBeEditable();
      await expect
        .poll(() => page.evaluate(() => window.startupNavigation))
        .toEqual({ status: "opened" });
    } finally {
      gate.release();
    }
  });
});
