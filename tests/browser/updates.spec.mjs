import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });

// Native IPC is the boundary fixture; the updater plugin client, the
// updates owner, Settings and the toast are production code. Plugin commands
// are denied unless the main-window capability grants them, as Tauri's ACL does.
async function nativeUpdater(
  page,
  { checkResults, installErrors = [], restartErrors = [], holdChecks = false },
) {
  const capability = JSON.parse(
    await readFile(
      new URL("../../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  );
  const granted = capability.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  await page.addInitScript(
    ({ granted, checkResults, installErrors, restartErrors, holdChecks }) => {
      window.isTauri = true;
      window.updaterCalls = [];
      window.checkResults = checkResults;
      const plugins = ["channels", "github", "bestie", "projects"].map(
        (name) => ({
          manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
          source: "bundled",
          enabled: true,
          revision: "bundled",
          previous: null,
          reloadable: false,
          error: null,
        }),
      );
      let nextCallback = 0;
      let nextResource = 100;
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => ++nextCallback,
        unregisterCallback() {},
        invoke: async (command, args) => {
          if (command === "deep_link_take") return [];
          if (command === "deep_link_watch") return;
          if (command === "plugin_catalog")
            return {
              status: "ready",
              externalPluginsPaused: false,
              catalog: {
                profile: "fixture",
                location: "isolated IPC",
                plugins: structuredClone(plugins),
              },
            };
          if (command === "plugin_module") return "export function apply() {}";
          const plugin = /^plugin:(updater|resources)\|(\w+)$/.exec(command);
          if (!plugin && command !== "update_restart")
            throw new Error(`Unexpected command ${command}`);
          window.updaterCalls.push({ command, args });
          const [, name, action] = plugin ?? [];
          const permission = plugin
            ? `${name === "resources" ? "core:" : ""}${name}:allow-${action.replaceAll("_", "-")}`
            : "allow-update-restart";
          if (!granted.includes(permission))
            throw new Error(
              `${command} not allowed. Permissions: ${permission}`,
            );
          if (command === "plugin:updater|check") {
            if (
              holdChecks &&
              window.updaterCalls.filter((call) => call.command === command)
                .length > 1
            )
              await new Promise((resolve) => {
                window.finishCheck = resolve;
              });
            const result = window.checkResults.shift();
            if (typeof result === "string") throw new Error(result);
            return result
              ? {
                  rid: ++nextResource,
                  version: "1.2.3",
                  currentVersion: "1.0.0",
                }
              : null;
          }
          if (command === "plugin:updater|download")
            return new Promise((resolve) => {
              window.finishDownload = () => resolve(++nextResource);
            });
          if (command === "update_restart" && restartErrors.length)
            throw new Error(restartErrors.shift());
          if (command === "plugin:updater|install" && installErrors.length)
            throw new Error(installErrors.shift());
        },
      };
    },
    { granted, checkResults, installErrors, restartErrors, holdChecks },
  );
}

async function openUpdates(page, app) {
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Updates").click();
  return page
    .getByRole("region", { name: "Software Updates", exact: true })
    .getByRole("status");
}

const commands = (page) =>
  page.evaluate(() => window.updaterCalls.map((call) => call.command));

test("update checks recover from failure, download, and restart from the toast", async ({
  page,
  app,
}) => {
  // The startup background check finds nothing; manual checks consume the rest.
  await nativeUpdater(page, {
    checkResults: [null, null, "network down", true],
    holdChecks: true,
  });
  const status = await openUpdates(page, app);
  const notices = page.getByRole("region", { name: "App notifications" });

  await expect(status).toHaveText("Check if a new version is available.");
  const action = button(page, "Check for Updates");
  await action.focus();
  // Native focus must survive the held IPC check and every result row.
  for (const [label, result] of [
    ["Check for Updates", "You're on the latest version."],
    ["Check Again", "Update failed: network down"],
    ["Retry", "Downloading update..."],
  ]) {
    await button(page, label).press("Enter");
    await expect(status).toHaveText("Checking for updates...");
    await expect(button(page, "Check for Updates")).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => typeof window.finishCheck))
      .toBe("function");
    await page.evaluate(() => {
      window.finishCheck();
      delete window.finishCheck;
    });
    await expect(status).toHaveText(result);
    await expect(
      page
        .getByRole("region", { name: "Software Updates", exact: true })
        .getByRole("button"),
    ).toBeFocused();
  }
  await expect(status).toHaveText("Downloading update...");
  await expect(notices.getByText("Ready to update!")).toHaveCount(0);

  await page.evaluate(() => window.finishDownload());
  await expect(status).toHaveText("Update downloaded. Click to apply.");
  await button(page, "Appearance").click();
  await expect(notices.getByText("Ready to update!")).toBeVisible();
  await expect(notices.getByText("Click to update")).toBeVisible();
  await notices
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  await expect
    .poll(() => commands(page))
    .toEqual([
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "update_restart",
    ]);
  const install = await page.evaluate(() =>
    window.updaterCalls.find((c) => c.command === "plugin:updater|install"),
  );
  expect(install.args).toEqual({ updateRid: 101, bytesRid: 102 });
});

test("retry after a failed install releases native update resources before checking again", async ({
  page,
  app,
}) => {
  await nativeUpdater(page, {
    checkResults: [true, true],
    installErrors: ["read-only location"],
    restartErrors: ["shutdown refused"],
  });
  const status = await openUpdates(page, app);
  await expect(status).toHaveText("Downloading update...");
  await page.evaluate(() => window.finishDownload());
  await button(page, "Appearance").click();
  await page
    .getByRole("region", { name: "App notifications" })
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  const notices = page.getByRole("region", { name: "App notifications" });
  await expect(
    notices.getByText("Update failed", { exact: true }),
  ).toBeVisible();
  await expect(notices.getByText("read-only location")).toBeVisible();
  await notices.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(notices.getByText("Downloading update...")).toBeVisible();
  const calls = await page.evaluate(() => window.updaterCalls);
  expect(calls.slice(3).map(({ command, args }) => [command, args])).toEqual([
    ["plugin:resources|close", { rid: 102 }],
    ["plugin:resources|close", { rid: 101 }],
    [
      "plugin:updater|check",
      { headers: [["cache-control", "no-cache"]], timeout: 30_000 },
    ],
    [
      "plugin:updater|download",
      expect.objectContaining({ rid: 103, timeout: 1_800_000 }),
    ],
  ]);
  await page.evaluate(() => window.finishDownload());
  await notices
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  await expect(notices.getByText("shutdown refused")).toBeVisible();
  await notices.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    notices.getByText("You're on the latest version."),
  ).toBeVisible();
});

test("the ready toast yields to Settings → Updates, which offers the same action", async ({
  page,
  app,
}) => {
  // Default main window size (src-tauri/tauri.conf.json).
  await page.setViewportSize({ width: 1200, height: 800 });
  await nativeUpdater(page, { checkResults: [true] });
  const status = await openUpdates(page, app);
  const toast = page
    .getByRole("region", { name: "App notifications" })
    .getByText("Ready to update!");
  await page.evaluate(() => window.finishDownload());
  await expect(status).toHaveText("Update downloaded. Click to apply.");
  await expect(toast).toHaveCount(0);

  await button(page, "Appearance").click();
  await expect(toast).toBeVisible();
  await button(page, "Updates").click();
  await expect(toast).toHaveCount(0);

  await button(page, "Update Now").click();
  await expect
    .poll(() => commands(page))
    .toEqual([
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "update_restart",
    ]);
});
