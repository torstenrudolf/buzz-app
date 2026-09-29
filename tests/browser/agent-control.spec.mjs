import { test, expect } from "@playwright/test";
import { npubEncode } from "nostr-tools/nip19";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

async function closeEditor(page) {
  const dialog = page.getByRole("dialog", { name: "Edit agent", exact: true });
  if (await dialog.count())
    await dialog.getByRole("button", { name: "Close editor" }).click();
}
async function openImport(panel) {
  await panel
    .getByRole("button", {
      name: "Import from another installation",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("button", { name: "Import Fixture agent" }),
  ).toBeVisible();
  const options = panel.getByText("Import options", { exact: true });
  if (!(await options.evaluate((el) => el.parentElement.open)))
    await options.click();
}
async function openEditor(page, name = "Fixture agent") {
  const dialog = page.getByRole("dialog", { name: "Edit agent", exact: true });
  if (!(await dialog.count())) {
    await page
      .getByRole("article", { name: `Agent ${name}`, exact: true })
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  }
  const runtime = dialog.getByRole("button", { name: "Runtime", exact: true });
  if ((await runtime.getAttribute("aria-expanded")) !== "true")
    await runtime.click();
  for (const name of ["Environment", "Model"]) {
    const summary = dialog.getByRole("button", { name, exact: true });
    if ((await summary.getAttribute("aria-expanded")) !== "true")
      await summary.click();
  }
  return dialog;
}

test("local controls preserve drafts, confirm operations and distinguish disabled from sleeping", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const errors = watchPageErrors(page);
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const panel = page.getByRole("region", {
      name: "Local agent controls",
      includeHidden: true,
    });
    const editor = await openEditor(page);
    await expect(
      editor.getByText("Process running · relay readiness unverified", {
        exact: true,
      }),
    ).toBeVisible();
    await editor
      .getByRole("button", { name: "Technical details", exact: true })
      .click();
    await expect(
      editor.getByText(npubEncode("ab".repeat(32)), { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText("ab".repeat(32), { exact: true }),
    ).toHaveCount(0);

    await editor
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("My unsaved prompt");
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await page.evaluate(() => window.agentControlFixture.failSave(true));
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByRole("alert").first()).toContainText(
      "Could not confirm",
    );
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await page.evaluate(() => window.agentControlFixture.failSave(false));
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await editor
      .getByLabel("Replacement for EXAMPLE_TOKEN")
      .fill("fixture-only-value");
    await expect(
      editor.getByLabel("Replacement for EXAMPLE_TOKEN"),
    ).toHaveAttribute("type", "password");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(
      editor.getByText(/Saved revision 2 · Running revision 1/),
    ).toBeVisible();
    await expect(
      editor.getByLabel("Replacement for EXAMPLE_TOKEN"),
    ).toHaveValue("");
    const saved = await page.evaluate(() =>
      window.agentControlFixture.calls
        .filter((call) => call.action === "save")
        .at(-1),
    );
    expect(saved.payload.edit.environment).toEqual({
      EXAMPLE_TOKEN: "fixture-only-value",
    });
    await editor.getByRole("button", { name: "Restart to apply" }).click();
    await expect(
      editor.getByText(/Saved revision 2 · Running revision 2/),
    ).toBeVisible();
    await editor
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("Keep this conflict draft");
    await page.evaluate(async () => {
      window.agentControlFixture.agent.revision++;
      await window.agentControlFixture.control.refresh();
    });
    await expect(editor.getByRole("alert")).toContainText(
      "newer saved revision",
    );
    await expect(
      editor.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("Keep this conflict draft");
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Process stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText(
        "Manual start · a later sent mention can start this agent",
        { exact: true },
      ),
    ).toBeVisible();
    const before = await page.evaluate(() =>
      window.agentControlFixture.calls.filter(
        (call) => call.action !== "snapshot",
      ),
    );
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action !== "snapshot",
        ),
      ),
    ).toEqual(before);
    await closeEditor(page);
    await openImport(panel);
    await panel
      .getByRole("combobox", { name: "Source library", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Development Buzz", exact: true })
      .click();
    await panel
      .getByLabel("Destination community", { exact: true })
      .fill("wss://chosen.example");
    await panel.getByRole("button", { name: "Load agents" }).click();
    await expect(
      panel.getByText("/fixture/development/managed-agents.json"),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Import Fixture agent" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action === "import",
        ),
      ),
    ).toEqual([]);
    await panel.getByRole("button", { name: "Import Fixture agent" }).click();
    // Only the two managed identities have controls; the template stays read-only.
    await expect(
      panel.getByRole("article").filter({
        has: page.getByRole("button", { name: /^Actions for / }),
      }),
    ).toHaveCount(2);
    await expect(
      panel
        .getByRole("region", { name: "Library identities", exact: true })
        .getByRole("article"),
    ).toHaveCount(0);
    await expect(
      panel
        .getByRole("region", { name: "Profiles without identities" })
        .getByRole("article", { name: "Agent Library only", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.data.agents.every((a) => !a.enabled),
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("agent-controls-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Toggle appearance" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "Add agent" }).blur();
    await page.mouse.move(0, 0);
    // Primary aliases prominent: dark resting fill is white, grey is hover.
    await expect(panel.getByRole("button", { name: "Add agent" })).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.screenshot({
      path: test.info().outputPath("agent-controls-dark-narrow.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Toggle browser-only mode" })
      .click();
    await closeEditor(page);
    await expect(panel.getByText(/This browser cannot run/)).toBeVisible();
    // Library-only entries no longer pretend to be managed cards with Edit.
    await expect(panel.getByText("Add agent", { exact: true })).toHaveCount(0);
    const libraryCard = page.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(libraryCard).toBeVisible();
    await expect(
      libraryCard.getByRole("button", { name: /Actions|Start|Edit/ }),
    ).toHaveCount(0);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("explicit-on preference survives Stop without changing the enabled state", async ({
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
    const editor = await openEditor(page);
    // Native owns the legacy None → enabled projection (store/tests.rs).
    // This browser fixture witnesses explicit-on while running and after Stop.
    await page.evaluate(() =>
      window.agentControlFixture.control.setStartOnAppLaunch(
        "fixture-agent",
        true,
      ),
    );
    await expect(
      editor.getByText("Enabled · starts with buzz-app", { exact: true }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Process stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText("Start on launch enabled", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        enabled: window.agentControlFixture.agent.enabled,
        startOnAppLaunch: window.agentControlFixture.agent.startOnAppLaunch,
        actions: window.agentControlFixture.calls.filter((call) =>
          ["startOnAppLaunch", "stop"].includes(call.action),
        ),
      })),
    ).toEqual({
      enabled: false,
      startOnAppLaunch: true,
      actions: [
        {
          action: "startOnAppLaunch",
          payload: { id: "fixture-agent", enabled: true },
        },
        { action: "stop", payload: { id: "fixture-agent" } },
      ],
    });
  } finally {
    await server.close();
  }
});

for (const previouslyStopped of [false, true]) {
  test(`unreadable status allows only explicit Stop from a retained ${previouslyStopped ? "stopped" : "running"} snapshot`, async ({
    page,
  }) => {
    // Own the five-second status poll so it cannot replace the operation error
    // before assertions observe it on slower runners.
    const now = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: now });
    const server = await createServer({
      ...config,
      configFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    try {
      // Install before the five-second status poll exists; paused below at a
      // fixed instant beyond this test's timeout, never runner "now".
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
      );
      const panel = page.getByRole("region", {
        name: "Local agent controls",
        includeHidden: true,
      });
      const editor = await openEditor(page);
      const stop = editor.getByRole("button", { name: "Stop", exact: true });
      if (previouslyStopped) {
        await stop.click();
        await expect(stop).toBeDisabled();
      }
      await closeEditor(page);
      await openImport(panel);
      await panel
        .getByLabel("Destination community", { exact: true })
        .fill("wss://chosen.example");
      await panel.getByRole("button", { name: "Load agents" }).click();
      await openEditor(page);
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      await page.evaluate(() => {
        const fixture = window.agentControlFixture;
        const { snapshot, action } = fixture.host;
        fixture.host.snapshot = async () => {
          throw "Unreadable settings.";
        };
        fixture.host.action = async (id, operation) => {
          if (operation !== "stop") return action(id, operation);
          fixture.calls.push({ action: operation, payload: { id } });
          // Native teardown succeeded, but durable disable failed: no snapshot confirmation.
          fixture.agent.status = "stopped";
          fixture.agent.runningRevision = null;
          throw "Stopped owned process, but could not persist disabled settings.";
        };
        fixture.restoreStore = () =>
          Object.assign(fixture.host, { snapshot, action });
      });
      await page.evaluate(() => window.agentControlFixture.control.refresh());
      await expect(page.getByRole("alert")).toContainText("Could not refresh");
      await expect(stop).toBeEnabled();
      if (previouslyStopped)
        await expect(
          editor.getByRole("button", { name: "Start", exact: true }),
        ).toBeDisabled();
      await expect(
        editor.getByRole("button", { name: "Restart", exact: true }),
      ).toBeDisabled();
      await editor
        .getByRole("textbox", { name: "Agent instructions", exact: true })
        .fill("Keep my recovery draft");
      await expect(
        editor.getByRole("button", { name: "Save changes", exact: true }),
      ).toBeDisabled();
      for (const name of ["Import Fixture agent"]) {
        await expect(
          panel.getByRole("button", { name, exact: true, includeHidden: true }),
        ).toBeDisabled();
      }
      await page.evaluate(() => window.agentControlFixture.control.refresh());
      await expect(page.getByRole("alert")).toContainText("Could not refresh");
      const before = await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action !== "snapshot",
        ),
      );
      // From here only explicit actions may read or write: a poll tick would
      // replace the failed Stop's guidance, or recover before the explicit retry.
      await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
      await stop.click();
      await expect(page.getByRole("alert")).toContainText(
        "could not persist disabled settings",
      );
      await expect(page.getByRole("alert")).toContainText("Could not confirm");
      await expect(
        panel.getByText("The agent statuses below may be out of date."),
      ).toBeVisible();
      if (!previouslyStopped) {
        await expect(
          editor.getByText("Enabled · manual-start only", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          editor.getByText(
            "Last known: Process running · relay readiness unverified",
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        await expect(
          editor.getByText("Process stopped", { exact: true }),
        ).toHaveCount(0);
      }
      await expect(
        editor.getByRole("textbox", {
          name: "Agent instructions",
          exact: true,
        }),
      ).toHaveValue("Keep my recovery draft");
      await expect(
        editor.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await expect(stop).toBeEnabled();
      expect(
        await page.evaluate(() =>
          window.agentControlFixture.calls.filter(
            (call) => call.action !== "snapshot",
          ),
        ),
      ).toEqual([
        ...before,
        { action: "stop", payload: { id: "fixture-agent" } },
      ]);
      await page.clock.runFor(5000);
      await expect(page.getByRole("alert")).toContainText("Could not refresh");
      // Repairing the host does not implicitly retry. A second explicit Stop can recover.
      await page.evaluate(() => window.agentControlFixture.restoreStore());
      await stop.click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        editor.getByText("Process stopped", { exact: true }),
      ).toBeVisible();
      await expect(
        editor.getByText(
          "Manual start · a later sent mention can start this agent",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        editor.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled();
    } finally {
      await server.close();
    }
  });
}

test("unavailable runtime blocks launch and credential import while retaining Stop", async ({
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
      const fixture = window.agentControlFixture;
      fixture.data.runtimeAvailable = false;
      fixture.data.importAvailable = false;
      fixture.data.runtimeMessage = "Execution blocked by native host";
      fixture.agent.status = "stopped";
      fixture.agent.runningRevision = null;
      fixture.agent.enabled = true;
      await fixture.control.refresh();
    });
    const panel = page.getByRole("region", {
      name: "Local agent controls",
      includeHidden: true,
    });
    await closeEditor(page);
    await expect(
      panel
        .getByRole("region", { name: "My agents" })
        .getByText("Execution blocked by native host"),
    ).toBeVisible();
    const editor = await openEditor(page);
    await expect(
      editor.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Restart", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled();
    await closeEditor(page);
    await openImport(panel);
    await expect(
      panel.getByText(/Import is unavailable in this app session/),
    ).toBeVisible();
    await panel
      .getByLabel("Destination community", { exact: true })
      .fill("wss://chosen.example");
    await panel.getByRole("button", { name: "Load agents" }).click();
    await expect(
      panel.getByRole("button", { name: "Import Fixture agent" }),
    ).toBeDisabled();
    await openEditor(page);
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Process stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText(
        "Manual start · a later sent mention can start this agent",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter((call) =>
          ["start", "restart", "import"].includes(call.action),
        ),
      ),
    ).toEqual([]);
  } finally {
    await server.close();
  }
});

test("native-supplied harness choices preserve current values and save only explicit edits", async ({
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
    const editor = await openEditor(page);

    const harness = editor.getByRole("combobox", {
      name: "Harness",
      exact: true,
    });
    const provider = editor.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    const executable = editor.getByRole("textbox", {
      name: "Executable",
      exact: true,
    });
    const model = editor.getByRole("textbox", {
      name: "Model ID (custom or blank)",
      exact: true,
    });
    const prompt = editor.getByRole("textbox", {
      name: "Agent instructions",
      exact: true,
    });
    const save = editor.getByRole("button", { name: "Save changes" });
    const lastSave = () =>
      page.evaluate(
        () =>
          window.agentControlFixture.calls
            .filter((c) => c.action === "save")
            .at(-1).payload,
      );
    const original = await page.evaluate(() =>
      structuredClone(window.agentControlFixture.agent.harness),
    );
    delete original.environmentKeys;
    await expect(executable).toHaveValue("fixture-acp");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("fixture-provider");
    await expect(save).toBeDisabled();
    await prompt.fill("Unrelated edit");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: original,
      environment: {},
    });

    // Selecting either suggestion changes only that field: no implicit args/model/env rewrite.
    await harness.click();
    await page.getByRole("option", { name: "Buzz Agent", exact: true }).click();
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("fixture-provider");
    await provider.click();
    await page
      .getByRole("option", { name: "Databricks v2", exact: true })
      .click();
    await expect(model).toHaveValue(original.model);
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        ...original,
        command: "buzz-agent",
        provider: "databricks_v2",
      },
      environment: {},
    });
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();

    await openEditor(page);
    await expect(harness).toHaveText("Buzz Agent");
    await expect(provider).toHaveText("Databricks v2");
    await expect(save).toBeDisabled();

    // Merely entering custom editing never writes a placeholder or erases the current value.
    await harness.click();
    await page
      .getByRole("option", {
        name: "Custom executable / current value",
        exact: true,
      })
      .click();
    await expect(executable).toHaveValue("buzz-agent");
    await expect(save).toBeDisabled();
    await executable.fill("/custom path/buzz-agent");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("databricks_v2");
    await provider.click();
    await page.getByRole("option", { name: "Not set", exact: true }).click();
    await model.fill("");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        ...original,
        command: "/custom path/buzz-agent",
        model: "",
        provider: "",
      },
      environment: {},
    });
    await expect(executable).toHaveValue("/custom path/buzz-agent");
    await provider.click();
    await page
      .getByRole("option", {
        name: "Custom provider / current value",
        exact: true,
      })
      .click();
    await editor
      .getByLabel("Custom provider", { exact: true })
      .fill("unknown-provider");
    await model.fill("unknown-model");
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("unknown-provider");
    await page.evaluate(async () => {
      window.agentControlFixture.agent.revision++;
      await window.agentControlFixture.control.refresh();
    });
    await expect(save).toBeDisabled();
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await expect(model).toHaveValue("");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("");
    await expect(executable).toHaveValue("/custom path/buzz-agent");

    // Re-read blank selectors plus unknown/absolute command; unrelated saves stay exact.
    await prompt.fill("Blank selectors stay blank");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        ...original,
        command: "/custom path/buzz-agent",
        model: "",
        provider: "",
      },
      environment: {},
    });
    await editor
      .getByLabel("Custom provider", { exact: true })
      .fill("unknown-provider");
    await model.fill("unknown-model");

    const args = ["--custom", "literal space", 'quoted "value"'];
    await editor
      .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
      .fill(JSON.stringify(args));
    await save.click();
    await prompt.fill("Keep unknown values too");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        command: "/custom path/buzz-agent",
        args,
        model: "unknown-model",
        provider: "unknown-provider",
      },
      environment: {},
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("harness-dropdown-narrow.png"),
      fullPage: true,
    });
    await expect(
      editor.getByText(/Environment overrides take precedence/),
    ).toBeVisible();
  } finally {
    await server.close();
  }
});

test("editor renders host choices rather than its own catalog, and tolerates an older host", async ({
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
    const editor = await openEditor(page);
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      f.data.harnessOptions = [
        {
          command: "host-command",
          label: "Host harness",
          providers: [{ value: "host-provider", label: "Host provider" }],
        },
      ];
      await f.control.refresh();
    });

    const harness = editor.getByRole("combobox", {
      name: "Harness",
      exact: true,
    });
    const provider = editor.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await harness.click();
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
      "Host harness",
      "Custom executable / current value",
    ]);
    await page
      .getByRole("option", { name: "Host harness", exact: true })
      .click();
    await provider.click();
    await page
      .getByRole("option", { name: "Host provider", exact: true })
      .click();
    await editor.getByRole("button", { name: "Save changes" }).click();
    expect(
      await page.evaluate(() => window.agentControlFixture.agent.harness),
    ).toMatchObject({ command: "host-command", provider: "host-provider" });
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      delete f.data.harnessOptions;
      await f.control.refresh();
    });
    await expect(
      editor.getByRole("textbox", { name: "Executable", exact: true }),
    ).toHaveValue("host-command");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("host-provider");
    await expect(
      editor.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
  } finally {
    await server.close();
  }
});

for (const launch of ["start", "restart"]) {
  for (const lateFailure of [false, true]) {
    test(`${launch} credential wait leaves real Stop buttons usable and ignores late ${lateFailure ? "failure" : "success"}`, async ({
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
        await expect(
          page.getByRole("article", { name: "Agent Fixture agent" }),
        ).toBeVisible();
        await page.evaluate(
          async ({ launch, lateFailure }) => {
            const f = window.agentControlFixture;
            f.agent.enabled = launch === "restart";
            f.agent.status = launch === "restart" ? "running" : "stopped";
            f.data.agents.push({
              ...structuredClone(f.agent),
              id: "other",
              pubkey: "bc".repeat(32),
              name: "Other running agent",
              enabled: true,
              status: "running",
            });
            await f.control.refresh();
            const stale = structuredClone(f.data);
            f.host.action = (id, action) => {
              f.calls.push({ action, payload: { id } });
              if (action !== "stop")
                return new Promise((resolve, reject) => {
                  window.releaseLaunch = () =>
                    lateFailure
                      ? reject("Late cancelled launch")
                      : resolve(stale);
                });
              return new Promise((resolve) => {
                window.releaseStop = () => {
                  const row = f.data.agents.find((agent) => agent.id === id);
                  row.enabled = false;
                  row.status = "stopped";
                  row.runningRevision = null;
                  resolve(structuredClone(f.data));
                };
              });
            };
          },
          { launch, lateFailure },
        );
        const first = await openEditor(page);
        const other = first; // one dialog; target changes only via exact card selection
        const firstStop = first.getByRole("button", {
          name: "Stop",
          exact: true,
        });
        const otherStop = firstStop;
        await first
          .getByRole("button", {
            name: launch === "start" ? "Start" : "Restart",
            exact: true,
          })
          .click();
        await expect
          .poll(() => page.evaluate(() => typeof window.releaseLaunch))
          .toBe("function");
        await expect(firstStop).toBeEnabled(); // even the previously stopped row
        await closeEditor(page);
        await openEditor(page, "Other running agent");
        await expect(otherStop).toBeEnabled();
        await expect(
          other.getByRole("button", { name: "Restart", exact: true }),
        ).toBeDisabled();
        // A different running agent can be stopped without releasing the prompt.
        await otherStop.click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                window.agentControlFixture.calls
                  .filter((call) => call.action === "stop")
                  .at(-1)?.payload.id,
            ),
          )
          .toBe("other");
        await expect(firstStop).toBeDisabled(); // one Stop IPC at a time
        await page.evaluate(() => window.releaseStop());
        await expect(
          other.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          other.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await closeEditor(page);
        await openEditor(page);
        await expect(firstStop).toBeEnabled();
        // Then cancel the pending launch via the real button/projection as well.
        await firstStop.click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                window.agentControlFixture.calls
                  .filter((call) => call.action === "stop")
                  .at(-1)?.payload.id,
            ),
          )
          .toBe("fixture-agent");
        await page.evaluate(() => window.releaseStop());
        await expect(
          first.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          first.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          first.getByRole("button", { name: "Restart", exact: true }),
        ).toBeDisabled();
        await page.evaluate(() => window.releaseLaunch());
        await expect
          .poll(() =>
            page.evaluate(
              () => window.agentControlFixture.control.snapshot().pendingLaunch,
            ),
          )
          .toBe(null);
        await expect(
          first.getByRole("button", { name: "Restart", exact: true }),
        ).toBeEnabled();
        await expect(
          first.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          first.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await closeEditor(page);
        await openEditor(page, "Other running agent");
        await expect(
          other.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          other.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page
            .getByRole("region", { name: "Local agent controls" })
            .getByRole("alert"),
        ).toHaveCount(0);
      } finally {
        await server.close();
      }
    });
  }
}

for (const changed of ["destination", "source"]) {
  test(`import ${changed} edits invalidate candidates and fence delayed previews`, async ({
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
      const panel = page.getByRole("region", {
        name: "Local agent controls",
        includeHidden: true,
      });
      await closeEditor(page);
      await openImport(panel);
      const destination = panel.getByLabel("Destination community", {
        exact: true,
      });
      const preview = panel.getByRole("button", {
        name: "Load agents",
      });
      const commit = panel.getByRole("button", {
        name: "Import Fixture agent",
      });
      await expect(destination).toHaveValue("https://relay.example.test");
      await expect(preview).toBeEnabled();
      await destination.fill("wss://first.example");
      await preview.click();
      await expect(commit).toBeEnabled();
      if (changed === "destination")
        await destination.fill("wss://chosen.example");
      else {
        await panel
          .getByRole("combobox", { name: "Source library", exact: true })
          .click();
        await page
          .getByRole("option", { name: "Development Buzz", exact: true })
          .click();
      }
      if (changed === "destination") {
        await expect(commit).toHaveCount(0);
        await preview.click();
      }
      await expect(commit).toBeEnabled();
      expect(
        await page.evaluate(() =>
          window.agentControlFixture.calls.filter(
            (call) => call.action === "import",
          ),
        ),
      ).toEqual([]);
      // Delay the actual host boundary, not a leaf projection helper.
      await page.evaluate(() => {
        const fixture = window.agentControlFixture;
        const original = fixture.host.previewImport;
        fixture.host.previewImport = async (...args) => {
          const result = await original(...args);
          await new Promise((resolve) => {
            fixture.releasePreview = resolve;
          });
          return result;
        };
        fixture.restorePreview = () => {
          fixture.host.previewImport = original;
        };
      });
      await preview.click();
      await expect(preview).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate(() => typeof window.agentControlFixture.releasePreview),
        )
        .toBe("function");
      // Inputs remain editable during this read-only preview; writes remain blocked.
      if (changed === "destination")
        await destination.fill("wss://final.example");
      else {
        await panel
          .getByRole("combobox", { name: "Source library", exact: true })
          .click();
        await page
          .getByRole("option", { name: "Installed Buzz", exact: true })
          .click();
      }
      await page.evaluate(() => window.agentControlFixture.releasePreview());
      await expect(preview).toBeEnabled();
      await expect(commit).toHaveCount(0);
      await page.evaluate(() => window.agentControlFixture.restorePreview());
      await preview.click();
      await expect(commit).toBeEnabled();
      const expectedDestination =
        changed === "destination"
          ? "wss://final.example"
          : "wss://first.example";
      await expect(
        panel.getByText(`Community: ${expectedDestination}`, { exact: true }),
      ).toBeVisible();
      await commit.click();
      const saved = await page.evaluate(() =>
        window.agentControlFixture.data.agents.at(-1),
      );
      expect(saved.relayUrl).toBe(expectedDestination);
      expect(saved.enabled).toBe(false);
      const calls = await page.evaluate(() => window.agentControlFixture.calls);
      expect(
        calls.filter((call) => call.action === "preview").at(-1).payload,
      ).toEqual({
        source: "installed",
        destination: expectedDestination,
      });
      expect(calls.filter((call) => call.action === "import")).toHaveLength(1);
      expect(
        calls.some(
          (call) => call.action === "start" || call.action === "restart",
        ),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });
}

test("rejected import preview keeps inputs and recovers through Load agents", async ({
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
    const panel = page.getByRole("region", {
      name: "Local agent controls",
      includeHidden: true,
    });
    await closeEditor(page);
    await openImport(panel);
    const destination = panel.getByLabel("Destination community", {
      exact: true,
    });
    const preview = panel.getByRole("button", {
      name: "Load agents",
    });
    await destination.fill("ws://not-supported.example");
    await page.evaluate(() => {
      const fixture = window.agentControlFixture;
      const original = fixture.host.previewImport;
      fixture.host.previewImport = async () => {
        throw "Choose a secure community origin without credentials, path or query";
      };
      fixture.restorePreview = () => {
        fixture.host.previewImport = original;
      };
    });
    await preview.click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Choose a secure community origin" }),
    ).toContainText("Choose a secure community origin");
    await expect(destination).toHaveValue("ws://not-supported.example");
    await expect(preview).toBeEnabled();
    await expect(destination).toBeEnabled();
    await page.evaluate(() => window.agentControlFixture.restorePreview());
    await destination.fill("wss://corrected.example");
    await preview.click();
    await expect(
      panel.getByText("Community: wss://corrected.example", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Import Fixture agent" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.some(
          (call) => call.action === "import",
        ),
      ),
    ).toBe(false);
  } finally {
    await server.close();
  }
});
