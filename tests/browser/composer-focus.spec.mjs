import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, dmLabels: true, developmentReact: true });

// Browser boundary: real sidebar navigation must hand focus to the mounted
// ProseMirror editor, including after a warm return; typing must need no click.
test("selecting a channel or DM focuses its composer and retains drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const conversation = page.getByRole("article", { name: "Conversation" });
  const input = conversation.getByRole("textbox");
  for (const [index, name] of [
    "Beta",
    "Alice Fixture",
    "Beta",
    "Alice Fixture",
  ].entries()) {
    await sidebar.getByRole("button", { name, exact: true }).click();
    await expect(input).toBeFocused();
    if (index < 2) {
      await page.keyboard.type(`Draft for ${name}`);
      await expect(input).toHaveText(`Draft for ${name}`);
    } else {
      await expect(input).toHaveText(`Draft for ${name}`);
      await page.keyboard.type(" continued");
      await expect(input).toHaveText(`Draft for ${name} continued`);
    }
  }
  const settings = page.getByRole("button", {
    name: "Channel settings",
    exact: true,
  });
  await settings.click();
  await expect(
    page.getByRole("button", { name: "Close channel settings" }),
  ).toBeFocused();
});

// Real DOM selection and keyboard insertion cannot be proved by jsdom. Use the
// app's development StrictMode so editor teardown/recreation remains covered.
test.describe("retained agent focus", () => {
  test.use({ agentPeers: true });

  test("returning after a send appends after all retained agents with the same recipients", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const input = page
      .getByRole("article", { name: "Conversation" })
      .getByRole("textbox");
    const recipients = app.participants.slice(1);
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    // Default remembering is enabled. Select identities through the real picker,
    // then let successful delivery create the follow-up draft, rather than seed it.
    for (const pubkey of recipients) {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button", { name: new RegExp(pubkey) })
        .click();
    }
    await page.keyboard.type("First request");
    await page.keyboard.press("Enter");
    await expect.poll(() => publications().length).toBe(1);
    const first = publications()[0].event;
    expect(first.content).toBe("@Bob Fixture @Carol Fixture First request");
    expect(first.tags.filter(([tag]) => tag === "p")).toEqual(
      recipients.map((key) => ["p", key]),
    );
    await expect(page.locator(`[data-message-id="${first.id}"]`)).toBeVisible();
    const retained = "@Bob Fixture @Carol Fixture ";
    await expect(input).toHaveJSProperty("value", retained);
    await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    // No editor click/fill/focus/selection setter or sleep after navigation.
    // Inspect native caret without giving ProseMirror a chance to repair it.
    const caret = await input.evaluate((element) => {
      const selection = document.getSelection();
      const node = selection?.anchorNode;
      return {
        focused: document.activeElement === element,
        collapsed: selection?.isCollapsed,
        trailingSpace:
          node?.nodeType === Node.TEXT_NODE &&
          node.textContent === " " &&
          element.contains(node) &&
          node.parentNode === element.lastChild &&
          !node.nextSibling,
        offset: selection?.anchorOffset,
      };
    });
    await page.keyboard.type("Next request");
    await expect(input).toHaveJSProperty("value", `${retained}Next request`);
    expect(caret).toEqual({
      focused: true,
      collapsed: true,
      trailingSpace: true,
      offset: 1,
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => publications().length).toBe(2);
    expect(publications()[1].event.content).toBe(`${retained}Next request`);
    expect(publications()[1].event.tags.filter(([tag]) => tag === "p")).toEqual(
      first.tags.filter(([tag]) => tag === "p"),
    );
    await expect(input).toHaveJSProperty("value", retained);
  });
});
