import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("on-demand model search preserves custom drafts and fences cancellation/context changes", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    // Install before page timers exist; pause at a fixed later instant below.
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await page
      .getByRole("article", { name: "Agent Fixture agent", exact: true })
      .getByRole("button", { name: "Actions for Fixture agent", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "Edit agent",
      exact: true,
    });
    await editor
      .getByRole("button", { name: "Environment", exact: true })
      .click();
    await editor
      .getByRole("combobox", { name: "Harness", exact: true })
      .click();
    await page.getByRole("option", { name: "Buzz Agent", exact: true }).click();
    await editor
      .getByRole("combobox", { name: "Provider", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Databricks v2", exact: true })
      .click();
    await editor.getByRole("button", { name: "Model", exact: true }).click();
    const model = editor.getByRole("textbox", {
      name: "Model ID (custom or blank)",
      exact: true,
      includeHidden: true,
    });
    const search = editor.getByRole("combobox", { name: "Model", exact: true });
    const browse = editor.getByRole("button", { name: "Browse models" });
    const host = editor.getByLabel("Databricks workspace (HTTPS origin)");
    await model.fill("custom.keep");
    // Escape as soon as Browse exposes the list, even before its pending frame.
    // Base UI defers pointer opening to rAF; a second, immediate open owner can
    // expose the list early and let that stale frame reopen it after Escape.
    // The fixed pause point is beyond this test's timeout, never runner "now".
    await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
    try {
      await browse.click();
      if ((await search.getAttribute("aria-expanded")) === "false")
        await page.clock.runFor(16);
      await expect(page.getByRole("listbox")).toBeVisible();
      await search.press("Escape");
      await page.clock.runFor(100);
      await expect(search).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("listbox")).toHaveCount(0);
    } finally {
      await page.clock.resume();
    }
    await expect(editor.getByRole("status")).toContainText(
      "Set your Databricks workspace",
    );
    await host.fill("https://workspace.example.com");
    expect(await page.evaluate(() => window.agentModelsFixture.calls)).toEqual(
      [],
    );
    // Only this geometry check opts into a catalog larger than the popup.
    await page.evaluate(() => window.agentModelsFixture.mode("many"));
    await browse.click();
    await expect(
      page.getByRole("option", { name: /Friendly Model/ }),
    ).toBeVisible();
    const list = page.getByRole("listbox");
    await expect(page.getByRole("option")).toHaveCount(21);
    const bounds = await list.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
    }));
    expect(bounds.height).toBeLessThanOrEqual(320);
    expect(bounds.content).toBeGreaterThan(bounds.height);
    const lastModel = page.getByRole("option", { name: /Catalog Model 20/ });
    await lastModel.scrollIntoViewIfNeeded();
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await search.fill("Catalog Model 20");
    await expect(lastModel).toBeVisible();
    await expect(
      page.getByRole("option", { name: /Friendly Model/ }),
    ).toHaveCount(0);
    await search.press("Escape");
    await browse.click();
    await page.evaluate(() => window.agentModelsFixture.mode("success"));
    await expect(model).toHaveValue("custom.keep");
    await page.getByRole("option", { name: /Friendly Model/ }).click();
    await expect(model).toHaveValue("catalog.schema.real-model");
    await expect(search).toHaveValue("Friendly Model");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByText("Saved.", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => window.agentControlFixture.agent.harness.model),
    ).toBe("catalog.schema.real-model");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await page
      .getByRole("article", { name: "Agent Fixture agent", exact: true })
      .getByRole("button", { name: "Actions for Fixture agent", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await editor.getByRole("button", { name: "Model", exact: true }).click();
    await expect(model).toHaveValue("catalog.schema.real-model");
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(search).toHaveValue("Friendly Model");
    await search.fill("Other");
    await search.press("Escape");
    await expect(model).toHaveValue("catalog.schema.real-model");
    await browse.click();
    await page.getByRole("option", { name: /Other Model/ }).click();
    await expect(model).toHaveValue("endpoint-two");
    await expect(search).toHaveValue("Other Model");
    await model.fill("");
    await expect(search).toHaveValue("");
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(
      editor.getByRole("button", { name: "Refresh models" }),
    ).toBeEnabled();
    await expect(model).toHaveValue("");
    await host.fill("https://other.example.com");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await model.fill("keep-on-error");
    await page.evaluate(() => window.agentModelsFixture.mode("error"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(editor.getByRole("status")).toContainText(
      "Synthetic connection failure",
    );
    await expect(model).toHaveValue("keep-on-error");
    await page.evaluate(() => window.agentModelsFixture.mode("empty"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(editor.getByRole("status")).toContainText("No models found");
    await page.evaluate(() => window.agentModelsFixture.mode("wait"));
    await editor.getByRole("button", { name: "Retry models" }).click();
    await editor.getByRole("button", { name: "Runtime", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled();
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await editor.getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(editor.getByRole("status")).toContainText("Cancelled");
    const cancelled = await page.evaluate(
      () => window.agentModelsFixture.calls.length,
    );
    await browse.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await search.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    expect(
      await page.evaluate(() => window.agentModelsFixture.calls.length),
    ).toBe(cancelled);
    await page.evaluate(() => window.agentModelsFixture.mode("success"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await browse.click();
    await expect(
      page.getByRole("option", { name: /Friendly Model/ }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      f.agent.revision++;
      await f.control.refresh();
    });
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(model).toHaveValue("keep-on-error");
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await search.fill("Other");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(model).toHaveValue("endpoint-two");
    // The expanded Advanced section can leave the search above the scrollport.
    // Bring its anchor into view as a person would before choosing an option.
    await search.scrollIntoViewIfNeeded();
    await search.fill("my.custom.id");
    await page.getByRole("option", { name: /my.custom.id/ }).click();
    await expect(model).toHaveValue("my.custom.id");
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: test.info().outputPath("databricks-picker-dark.png"),
    });
    expect(
      await editor.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.evaluate(() => window.agentModelsFixture.mode("wait"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel sign-in" }),
    ).toBeEnabled();
    const before = await page.evaluate(
      () =>
        window.agentModelsFixture.calls.filter((x) => x === "cancel").length,
    );
    await editor.getByRole("button", { name: "Close editor" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.agentModelsFixture.calls.filter((x) => x === "cancel")
              .length,
        ),
      )
      .toBeGreaterThan(before);
    await page
      .getByRole("article", { name: "Agent Fixture agent", exact: true })
      .getByRole("button", { name: "Actions for Fixture agent", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(search).toHaveValue("catalog.schema.real-model");
    expect(
      await page.evaluate(
        () =>
          window.agentModelsFixture.calls.filter((x) => x === "cancel").length,
      ),
    ).toBeGreaterThan(before);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
