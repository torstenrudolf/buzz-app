import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";

test("Use here opens a visible dialog at desktop and narrow widths", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      f.data.parked = [];
      Object.assign(f.agent, {
        configured: false,
        enabled: false,
        status: "stopped",
        runningRevision: null,
      });
      await f.control.refresh();
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole("button", { name: "Use here", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Set up agent here" });
      await expect(dialog).toHaveCSS("position", "fixed");
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await expect(
        dialog.getByRole("button", { name: "Use here", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      await expect(close).toBeInViewport({ ratio: 1 });
      await close.click();
      await expect(dialog).toHaveCount(0);
    }
  } finally {
    await server.close();
  }
});
