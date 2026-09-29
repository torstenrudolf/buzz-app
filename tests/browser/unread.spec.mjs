import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

const alphaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test.use({
  productionBroker: true,
  readState: true,
  pluginFixtures: true, // Existing read-only session exposure for owner barriers.
  channelIds: [alphaId, "beta"],
  channelNames: { [alphaId]: "Alpha" },
  historyCounts: { [alphaId]: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const alpha = (page) => page.getByRole("button", { name: /^Alpha/ });
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
// Observe the real durable result, never seed state or call an engine test hook.
async function journal(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-read-state-v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("partitions", "readonly");
          const read = tx.objectStore("partitions").getAll();
          read.onsuccess = () => resolve(read.result[0]);
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
async function visible(page) {
  return history(page).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll("[data-message-id]")]
      .filter((row) => {
        const b = row.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          b.top >= viewport.top &&
          b.bottom <= viewport.bottom &&
          b.left >= viewport.left &&
          b.right <= viewport.right
        );
      })
      .map((row) => row.dataset.messageId);
  });
}
async function options(page) {
  const trigger = page.getByRole("button", {
    name: "Channel settings",
    exact: true,
  });
  const opening = (await trigger.getAttribute("aria-expanded")) === "false";
  await trigger.click();
  if (opening) {
    // The details and lifecycle readers finish independently. Observe both before
    // checking diagnostics so a late details alert cannot escape the assertion.
    await expect(
      page
        .getByRole("region", { name: "Edit channel details", exact: true })
        .getByText(
          "Only current channel owners and admins can edit these details.",
        ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Leave channel", exact: true }),
    ).toBeVisible();
    await page.getByText("Diagnostics", { exact: true }).click();
  }
}

// The real startup composition must order optional catalog reads after channel
// authority; completing that first roster cancels reads already in flight.
test("Messages startup waits for channel discovery before loading templates", async ({
  page,
  app,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let catalogRequested = false;
  page.on("request", (request) => {
    if (!request.url().endsWith("/query")) return;
    const filters = request.postDataJSON();
    if (filters.some((filter) => filter["#t"]?.includes("buzz-channel-kit-v1")))
      catalogRequested = true;
  });
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.some((filter) => filter.kinds?.includes(39002) && filter["#p"]))
      await gate;
    await route.continue();
  });
  // Emoji loading is a later effect in the same mounted Messages workspace.
  // Observing it establishes that the earlier template effect has run.
  const workspaceStarted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/query") &&
      request.postDataJSON().some((filter) => filter.kinds?.includes(30030)),
  );
  const catalogLoaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/query") &&
      response
        .request()
        .postDataJSON()
        .some((filter) => filter["#t"]?.includes("buzz-channel-kit-v1")),
  );
  try {
    await page.goto(app.origin);
    await workspaceStarted;
    expect(catalogRequested).toBe(false);
  } finally {
    release();
  }
  await catalogLoaded;
  await composer(page).waitFor();
  await settle(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("built sidebar → visible dwell → durable journal → encrypted broker publication; reload preserves intent", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await open(page, app);
  await expect
    .poll(() =>
      app.report.queries.some(({ filter }) => filter.read_state_snapshot === 1),
    )
    .toBe(true);
  // Wait for the bounded roster-wide repair, not merely the first 20-row head.
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    /^500 observed unread messages/,
  );
  await composer(page).focus();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.clock.runFor(900); // Composer focus is not reading, even past dwell.
  expect((await journal(page)).state.frontiers).toEqual({});
  expect(app.report.readPublications).toEqual([]);
  const ids = await visible(page);
  expect(ids.length).toBeGreaterThan(0);
  const before = Number(
    (await alpha(page).getByRole("img").getAttribute("aria-label")).split(
      " ",
    )[0],
  );
  await history(page).focus();
  await page.clock.runFor(300);
  expect((await journal(page)).state.frontiers).toEqual({});
  await page.clock.runFor(750);
  await expect
    .poll(async () => Object.keys((await journal(page)).state.frontiers).sort())
    .toEqual(ids.map((id) => `msg:${id}`).sort());
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${before - ids.length} observed unread messages`),
  );
  await page.clock.resume();
  const stored = await journal(page);
  expect(stored.state.frontiers[alphaId]).toBeUndefined();
  // The normal debounce, signing, NIP-44, NIP-98 and publication/readback all run.
  await expect
    .poll(() => app.report.readPublications.length, { timeout: 12000 })
    .toBe(1);
  await expect
    .poll(async () => (await journal(page)).acceptedRevision)
    .toBe(stored.revision);
  const { event, blob } = app.report.readPublications[0];
  expect(blob.contexts).toEqual(stored.state.frontiers);
  expect(event.content).not.toContain(ids[0]);
  expect(blob.contexts[alphaId]).toBeUndefined();
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await settle(page);
  expect((await journal(page)).slot).toBe(stored.slot);
  expect((await journal(page)).state.frontiers).toEqual(stored.state.frontiers);
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${before - ids.length} observed unread messages`),
  );
});

test("focus cancellation and local manual-unread survive dwell/reload until explicit mark-through", async ({
  page,
  app,
}) => {
  await page.clock.install();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const markerRequested = page.waitForRequest(
    (request) =>
      request.url().endsWith("/query") &&
      request.postDataJSON().some((filter) => filter.read_state_snapshot === 1),
  );
  await page.route("**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.read_state_snapshot === 1)
    )
      await gate;
    await route.continue();
  });
  try {
    await open(page, app);
    await markerRequested;
    // Mounted history is not proof that the serial durable owner is ready.
    expect(
      await page.evaluate(
        () => window.fixtureRelay.snapshot().session.unread.sync().completeness,
      ),
    ).toBe("unknown");
  } finally {
    release();
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sync = window.fixtureRelay.snapshot().session.unread.sync();
        return { status: sync.status, completeness: sync.completeness };
      }),
    )
    .toEqual({ status: "reconciled", completeness: "snapshot" });
  await composer(page).focus();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await history(page).focus();
  const ids = await visible(page);
  expect(ids.length).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        ({ ids, alphaId }) =>
          ids.every(
            (id) =>
              window.fixtureRelay
                .snapshot()
                .session.unread.attention(alphaId, id).viewing,
          ),
        { ids, alphaId },
      ),
    )
    .toBe(true);
  await page.clock.runFor(300);
  await composer(page).focus();
  await page.clock.runFor(900);
  await page.clock.resume();
  await options(page);
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  // This durable action is ordered behind any erroneous dwell mutation in the
  // same read-state queue; a separate IndexedDB read alone is not a barrier.
  await expect
    .poll(async () => (await journal(page)).localUnread[alphaId])
    .toBeGreaterThan(0);
  expect((await journal(page)).state.frontiers).toEqual({});
  await options(page);
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await composer(page).focus();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await history(page).focus();
  await page.clock.runFor(1000);
  expect((await journal(page)).localUnread[alphaId]).toBeGreaterThan(0);
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await page.clock.resume();
  app.relay.holdContent(); // Reload must use verified disk evidence, not wait for network repair.
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await options(page);
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await journal(page)).localUnread[alphaId])
    .toBeUndefined();
  await expect
    .poll(async () => (await journal(page)).state.frontiers[alphaId])
    .toBe(app.histories.get(`primary/${alphaId}`).at(-1).created_at);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
});

test("a surviving window publishes a closed window's durable read intent", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  await composer(page).focus();
  const survivor = await context.newPage();
  app.watchPageErrors(survivor);
  survivor.on("console", (message) => {
    if (message.type() === "error")
      app.report.consoleErrors.push(message.text());
  });
  try {
    await open(survivor, app);
    await composer(survivor).focus();
    await options(survivor);
    await survivor.getByText("Unread status", { exact: true }).click();
    await expect(
      survivor.getByText(/Read sync: frontier-sync · reconciled/),
    ).toBeVisible();
    await page.bringToFront();
    await history(page).focus();
    await expect
      .poll(async () => (await journal(page)).revision)
      .toBeGreaterThan(0);
    const stored = await journal(page);
    await expect(
      survivor.getByText(/Read sync: frontier-sync · pending/),
    ).toBeVisible();
    expect(app.report.readPublications).toEqual([]);
    await page.close(); // Cancel the origin publisher before its normal five-second debounce.
    await expect
      .poll(() => app.report.readPublications.length, { timeout: 12000 })
      .toBe(1);
    await expect
      .poll(async () => (await journal(survivor)).acceptedRevision)
      .toBe(stored.revision);
    expect(app.report.readPublications[0].blob.contexts).toEqual(
      stored.state.frontiers,
    );
    await expect(
      survivor.getByText(/Read sync: frontier-sync · reconciled/),
    ).toBeVisible();
  } finally {
    await survivor.close();
  }
});

test.describe("explicit mark-through with membership activity", () => {
  test.use({ membershipActivity: true });

  for (const activityOnly of [false, true]) {
    test(
      activityOnly
        ? "activity-only history explains the missing message without clearing manual unread"
        : "chat followed by membership activity clears manual unread through the newest chat",
      async ({ page, app }) => {
        // Model only upstream signed history; the app must load and verify it.
        const loaded = app.histories.get(`primary/${alphaId}`).slice(-4);
        app.histories.set(
          `primary/${alphaId}`,
          activityOnly
            ? loaded.filter((event) => event.kind === 40099)
            : loaded,
        );
        const lastChat = loaded.findLast((event) => event.kind === 9);
        await open(page, app);
        await composer(page).focus();
        await expect(
          history(page).locator("[data-membership-row]"),
        ).toHaveCount(1);
        if (!activityOnly) {
          await expect(alpha(page).getByRole("img")).toHaveAttribute(
            "aria-label",
            /^2 observed unread messages/,
          );
        }
        await options(page);
        await page
          .getByRole("button", {
            name: "Mark unread on this device",
            exact: true,
          })
          .click();
        await expect(alpha(page).getByRole("img")).toHaveAttribute(
          "aria-label",
          "Marked unread on this device only",
        );
        const before = await journal(page);
        await page
          .getByRole("button", {
            name: "Mark read through loaded messages",
            exact: true,
          })
          .click();
        if (activityOnly) {
          await expect(page.getByRole("alert")).toHaveText(
            "Load a verified message before marking through it.",
          );
          const after = await journal(page);
          expect(after.localUnread[alphaId]).toBe(before.localUnread[alphaId]);
          expect(after.state.frontiers).toEqual(before.state.frontiers);
          expect(after.revision).toBe(before.revision);
        } else {
          await expect
            .poll(async () => (await journal(page)).state.frontiers[alphaId])
            .toBe(lastChat.created_at);
          expect((await journal(page)).localUnread[alphaId]).toBeUndefined();
          await expect(alpha(page).getByRole("img")).toHaveCount(0);
          await expect(page.getByRole("alert")).toHaveCount(0);
        }
        // Do not let the shared fixture's legacy WebKit exception mask this path.
        expect(app.report.errors).toEqual([]);
      },
    );
  }
});
