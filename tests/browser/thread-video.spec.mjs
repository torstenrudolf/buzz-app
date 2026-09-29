import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ developmentReact: true });

test("channel thread hands off to a stable video viewer", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL(
          "../fixtures/message-gallery/assets/sample.mp4",
          import.meta.url,
        ),
      ),
      contentType: "video/mp4",
    }),
  );
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Thread video",
    true,
    true,
    undefined,
    undefined,
    [["imeta", "url https://primary.example/media/sample.mp4", "m video/mp4"]],
  );
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread.getByText("Thread video", { exact: true })).toBeVisible();
  await expect
    .poll(() => thread.locator("video").evaluate((video) => video.readyState))
    .toBeGreaterThanOrEqual(2);
  await thread.getByRole("button", { name: "Open video fullscreen" }).click();
  const dialog = page.getByRole("dialog", { name: "Video review" });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-review-opening");
  await expect(dialog).not.toHaveAttribute("data-review-pending");
  await expect
    .poll(() =>
      dialog
        .locator("video[data-review-media]")
        .evaluate((video) => video.currentTime),
    )
    .toBeGreaterThan(0.5);
  await dialog.getByRole("button", { name: "Close fullscreen viewer" }).click();
  await expect(dialog).toHaveCount(0);
});

test.describe("public channel preview", () => {
  test.use({ openSearch: true, productionBroker: true });

  test("keeps a thread reply video open without joining the channel", async ({
    page,
    app,
  }) => {
    await page.route("**/api/relay/primary/media?**", (route) =>
      route.fulfill({
        path: fileURLToPath(
          new URL(
            "../fixtures/message-gallery/assets/sample.mp4",
            import.meta.url,
          ),
        ),
        contentType: "video/mp4",
      }),
    );
    const root = app.searchTarget.tags.find(([key]) => key === "e")[1];
    app.append(
      "primary",
      "open",
      "Public thread video",
      false,
      false,
      root,
      undefined,
      [
        [
          "imeta",
          "url https://primary.example/media/sample.mp4",
          "m video/mp4",
        ],
      ],
    );
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search Buzz" })
      .fill("crew-search");
    await page
      .getByRole("option", { name: /crew-search exact public reply/ })
      .click();
    await expect(
      page.getByText(
        "Read-only preview · You haven’t joined this conversation.",
      ),
    ).toBeVisible();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.getByText("Public thread video", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => thread.locator("video").evaluate((video) => video.readyState))
      .toBeGreaterThanOrEqual(2);
    await thread.getByRole("button", { name: "Open video fullscreen" }).click();
    const dialog = page.getByRole("dialog", { name: "Video review" });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("data-review-opening");
    await expect
      .poll(() =>
        dialog
          .locator("video[data-review-media]")
          .evaluate((video) => video.currentTime),
      )
      .toBeGreaterThan(0.5);
    await page.screenshot({
      path: test.info().outputPath("public-thread-video-open.png"),
    });
    await dialog
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      page
        .getByRole("complementary", { name: "Channel sidebar" })
        .getByRole("button", { name: "open", exact: true }),
    ).toHaveCount(0);
  });
});
