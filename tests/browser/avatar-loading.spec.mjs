import { test, expect } from "./source-fixture.mjs";
import { fileURLToPath } from "node:url";

test("shared avatars defer offscreen artwork, omit the referrer and recover from failure", async ({
  page,
}) => {
  const requests = [];
  await page.route("https://images.example/avatar.png", async (route) => {
    requests.push(route.request().headers());
    await route.fulfill({
      path: fileURLToPath(
        new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
      ),
      contentType: "image/png",
    });
  });
  let sentinelRequests = 0;
  await page.route("https://images.example/sentinel.png", (route) => {
    sentinelRequests++;
    return route.fulfill({ status: 204 });
  });
  await page.goto(
    "/tests/fixtures/agents.html?external-avatar&offscreen-avatar",
  );
  await expect(
    page.getByRole("region", { name: "Agents", exact: true }),
  ).not.toBeInViewport();
  const avatar = page
    .getByRole("region", { name: "Library identities", exact: true })
    .getByRole("img", { name: /^A Brain identity/ })
    .first();
  const image = avatar.locator("img");
  // The library cards mount after an asynchronous refresh. The offscreen
  // avatar must exist with its source before the barrier can say anything
  // about whether it was deferred.
  await expect(image).toHaveAttribute(
    "src",
    "https://images.example/avatar.png",
  );
  // Barrier: a lazy image added on screen now is requested only after the
  // browser has evaluated lazy loading for the page, including the avatar.
  await page.evaluate(() => {
    const sentinel = document.createElement("img");
    sentinel.loading = "lazy";
    sentinel.alt = "";
    sentinel.src = "https://images.example/sentinel.png";
    document.body.prepend(sentinel);
  });
  await expect.poll(() => sentinelRequests).toBe(1);
  expect(requests).toHaveLength(0);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(
    page.getByRole("region", { name: "Agents", exact: true }),
  ).toBeInViewport();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].referer).toBeUndefined();

  await expect
    .poll(() => image.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveCSS("opacity", "1");
  await expect(avatar.locator("[data-avatar-shape]")).toHaveText("");
  const original = await avatar.boundingBox();

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("https://images.example/failure.png", async (route) => {
    await held;
    await route.abort();
  });
  await page.evaluate(() =>
    window.agentFixture.setArtwork("https://images.example/failure.png"),
  );
  await page
    .getByRole("button", { name: "Refresh agents", exact: true })
    .click();
  await expect(avatar).toContainText("A");
  await expect(image).toHaveCSS("opacity", "0");
  expect(await avatar.boundingBox()).toEqual(original);
  release();
  await expect(avatar).toContainText("A");
  await expect(avatar.locator("img")).toHaveCount(0);
  await page.evaluate(() =>
    window.agentFixture.setArtwork("https://images.example/avatar.png"),
  );
  await page
    .getByRole("button", { name: "Refresh agents", exact: true })
    .click();
  await expect
    .poll(() => image.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveCSS("opacity", "1");
  await expect(avatar.locator("[data-avatar-shape]")).toHaveText("");
});
