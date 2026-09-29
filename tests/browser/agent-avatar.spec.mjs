import { test, expect } from "./source-fixture.mjs";

// Compare rendered glyphs: computed font-size alone cannot detect an ancestor scale.
test("agent initials retain shared avatar typography at DM and chat sizes", async ({
  page,
}) => {
  const release = Promise.withResolvers();
  await page.route(
    "https://images.example/agent-fallback.png",
    async (route) => {
      await release.promise;
      await route.abort();
    },
  );
  await page.goto("/tests/fixtures/agent-avatar.html");
  const assertFallbacks = async () => {
    for (const size of [22, 40]) {
      const group = page.getByRole("region", { name: `${size}px avatars` });
      const initial = group
        .getByRole("img", { name: /^Agent/ })
        .locator("[data-avatar-shape] > span");
      const reference = group
        .getByRole("img", { name: "Reference" })
        .locator("span");
      await expect(initial).toHaveText("A");
      const glyph = (locator) =>
        locator.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rect = range.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
      const expected = await glyph(reference);
      await expect
        .poll(async () => {
          const actual = await glyph(initial);
          return Math.max(
            Math.abs(actual.width - expected.width),
            Math.abs(actual.height - expected.height),
          );
        })
        .toBeLessThan(0.1);
    }
  };
  try {
    await assertFallbacks();
    await page.getByRole("button", { name: "Toggle thinking" }).click();
    await assertFallbacks();
    await page.getByRole("button", { name: "Load picture" }).click();
    await assertFallbacks();
    release.resolve();
    await expect(page.locator("img")).toHaveCount(0);
    await assertFallbacks();
    await page.getByRole("button", { name: "Toggle thinking" }).click();
    await assertFallbacks();
  } finally {
    release.resolve();
  }
});
