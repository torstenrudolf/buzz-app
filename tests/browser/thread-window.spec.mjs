import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test("reconnect repair failure keeps retry reachable at the newest replies", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    await expect(replies).toHaveCount(10);
    await expect
      .poll(() =>
        history.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(2);
    const beforeRepair = await history.evaluate((el) => ({
      height: el.scrollHeight,
      top: el.querySelector("ol [data-message-id]").getBoundingClientRect().top,
    }));
    await page.evaluate(() => window.messagesFixture.holdReconnectRepair());
    // Observe the real pending read, not text that the product deliberately omits.
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.reconnectRepairPending()),
      )
      .toBe(true);
    await expect(history.getByText("Loading thread…")).toHaveCount(0);
    expect(
      await history.evaluate((el) => ({
        height: el.scrollHeight,
        top: el.querySelector("ol [data-message-id]").getBoundingClientRect()
          .top,
      })),
    ).toEqual(beforeRepair);
    await expect(history.getByText("Loading older replies…")).toHaveCount(0);
    await page.evaluate(() => window.messagesFixture.releaseReconnectRepair());
    const error = history.getByRole("alert");
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(error).toContainText("Retained range repair failed");
    await expect(retry).toBeInViewport();
    await expect(replies).toHaveCount(10);
    await retry.click();
    await expect(error).toHaveCount(0);
    // The click can scroll to the button and legitimately demand an older page;
    // recovery must retain the newest reply regardless of that extra request.
    await expect(
      history.getByText("First root reply 302", { exact: true }),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseReconnectRepair())
      .catch(() => {});
    await server.close();
  }
});

test("older-page retry repeats the failed continuation at the scrollback cue", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    await expect(replies).toHaveCount(10);
    await history.hover();
    await page.mouse.wheel(0, -4000);
    await expect(replies).toHaveCount(60);
    await page.evaluate(() => window.messagesFixture.failOlderPages(2));
    // Re-establish the scrollback boundary after the first page settles. One
    // wheel step alone can stop mid-history in WebKit's hosted viewport.
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await history.hover();
    await page.mouse.wheel(0, -300);
    const error = history.getByRole("alert");
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(error).toContainText("Older page failed");
    await expect(retry).toBeInViewport();
    await retry.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(4);
    await expect(error).toContainText("Older page failed");
    await expect(retry).toBeInViewport();
    await retry.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(5);
    await expect(replies).toHaveCount(110);
    await expect(retry).toHaveCount(0);
    const filters = await page.evaluate(
      () => window.messagesFixture.report.filters,
    );
    expect(filters).toHaveLength(5);
    expect(filters[2].until).toBeDefined();
    for (const filter of filters.slice(3)) {
      expect(filter.until).toBe(filters[2].until);
      expect(filter.before_id).toBe(filters[2].before_id);
    }
  } finally {
    await server.close();
  }
});

test("legacy continuation failure exposes recovery after retained replies", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?failLegacyContinuation=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    // The first page is started on mount; the next page is a separate read.
    await expect(replies).toHaveCount(50);
    const error = history.getByRole("alert");
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(error).toContainText("Legacy continuation failed");
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(replies).toHaveCount(61);
    await expect(error).toHaveCount(0);
  } finally {
    await server.close();
  }
});

// Browser boundary: actual layout/scroll anchoring and user demand over the real
// StrictMode session and ThreadPanel. Protocol permutations stay in owner tests.
test("older-page loading adds no row or layout shift while the request is held", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    await expect(replies).toHaveCount(10);
    // Settle at the top before the held request so native scrolling cannot
    // masquerade as a layout shift caused by a loading row.
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    const before = await history.evaluate((el) => ({
      height: el.scrollHeight,
      top: el.querySelector("ol [data-message-id]").getBoundingClientRect().top,
    }));
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    await history.hover();
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(2);
    const cue = history.getByText("Loading older replies…", { exact: true });
    await expect(cue).toHaveCount(0);
    await expect(history.getByText("Loading thread…")).toHaveCount(0);
    expect(
      await history.evaluate((el) => ({
        height: el.scrollHeight,
        top: el.querySelector("ol [data-message-id]").getBoundingClientRect()
          .top,
      })),
    ).toEqual(before);
    expect(await replies.count()).toBe(10);
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    await expect(replies).toHaveCount(60);
    await expect(cue).toHaveCount(0);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});

test("newest window positions immediately; scrollback preserves the visible reply and live following", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    await expect(replies).toHaveCount(10);
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(
      panel.getByText("First root reply 302", { exact: true }),
    ).toBeInViewport();
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect.poll(gap).toBeLessThan(2);
    const initial = await page.evaluate(
      () => window.messagesFixture.report.filters,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0].thread_window).toBe(true);
    // A user gesture, not mounting or live reflow, asks for older history.
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    // The wheel may still move the viewport after dispatch. Measure only after
    // the continuation is pending, then release it to isolate prepend geometry.
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await history.hover();
    // Already at the top: wheel input demands history but has no native scroll
    // to finish, so scrollend is not a completion signal for this gesture.
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(2);
    const continuation = await page.evaluate(
      () => window.messagesFixture.report.filters[1],
    );
    expect(continuation.thread_window).toBe(true);
    expect(continuation.until).toBeDefined();
    expect(continuation.before_id).toBeDefined();
    await expect(history.getByText("Loading older replies…")).toHaveCount(0);
    // Newly prepended content preserves the reply being read.
    const readingId = await history.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const visible = [...el.querySelectorAll("ol [data-message-id]")].filter(
        (row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
        },
      );
      const reading = visible[Math.floor(visible.length / 2)];
      if (!reading) throw new Error("No complete reply in the viewport");
      return reading.dataset.messageId;
    });
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    await expect(replies).toHaveCount(60);
    await expect(history.getByText("Loading older replies…")).toHaveCount(0);
    const readingReply = history.locator(`ol [data-message-id="${readingId}"]`);
    await expect(readingReply).toBeInViewport();
    // The page was prepended, not substituted for the reply being read.
    expect(
      await replies.evaluateAll(
        (rows, id) => rows.findIndex((row) => row.dataset.messageId === id),
        readingId,
      ),
    ).toBeGreaterThanOrEqual(50);
    await page.evaluate(() => window.messagesFixture.live());
    await expect(replies).toHaveCount(61);
    await expect(readingReply).toBeInViewport();
    await expect(
      history.getByText("Live reply", { exact: true }),
    ).toBeVisible();
    // Demand each remaining older page. No automatic full-history waterfall.
    for (const count of [111, 161, 211, 261, 305]) {
      await history.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      await history.hover();
      await page.mouse.wheel(0, -300);
      await expect(replies).toHaveCount(count);
    }
    expect(await history.locator("ol [data-message-id]").count()).toBe(305);
    const ids = await history
      .locator("ol [data-message-id]")
      .evaluateAll((rows) => rows.map((r) => r.dataset.messageId));
    expect(new Set(ids).size).toBe(305);
    expect(
      (await page.evaluate(() => window.messagesFixture.report.filters)).every(
        (f) => f.thread_window && f.thread_cursor === undefined,
      ),
    ).toBe(true);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});

test("older-page retry reparents a visible reply under its late parent", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1&nestedWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    const child = history.getByText("Nested window child", { exact: true });
    await expect(replies).toHaveCount(10);
    await page.evaluate(() => window.messagesFixture.failOlderPages(1));
    await history.hover();
    // The wheel may demand history at the top without moving the scroller.
    await page.mouse.wheel(0, -4000);
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(history.getByRole("alert")).toContainText("Older page failed");
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeInViewport();
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    await retry.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(3);
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeInViewport();
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    const parent = history.getByText("First root reply 292", { exact: true });
    await expect(parent).toBeVisible();
    await expect(child).toBeInViewport();
    await expect(replies).toHaveCount(60);
    // The missing parent must reparent this child without losing it from the
    // reader's viewport; the exact Y coordinate is not the user contract.
    expect(
      await parent.evaluate((el) =>
        el.closest("li")?.textContent.includes("Nested window child"),
      ),
    ).toBe(true);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});

test("older page reparents a visible reply under its late parent", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1&nestedWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const child = history.getByText("Nested window child", { exact: true });
    await expect(history.locator("ol [data-message-id]")).toHaveCount(10);
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    await history.hover();
    // The wheel may demand history at the top without moving the scroller.
    await page.mouse.wheel(0, -4000);
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(2);
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeInViewport();
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    const parent = history.getByText("First root reply 292", { exact: true });
    await expect(parent).toBeVisible();
    await expect(child).toBeVisible();
    await expect(child).toBeInViewport();
    // Verify the reply moved under its real parent, not just that it remained flat.
    expect(
      await parent.evaluate((el) =>
        el.closest("li")?.textContent.includes("Nested window child"),
      ),
    ).toBe(true);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});
