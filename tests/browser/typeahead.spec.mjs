import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

const open = async (page) => {
  await page.goto("/tests/fixtures/mentions.html?test-controls");
  return page.getByRole("textbox", { name: "Message #General" });
};
const expectAvatarShape = async (target, shape) => {
  await expect(target.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    shape,
  );
};
test("mention completion distinguishes exact agent identity without reshaping a namesake human", async ({
  page,
}) => {
  const input = await open(page);
  const keys = await page.evaluate(() => ({
    human: window.mentionFixture.first,
    agent: window.mentionFixture.second,
  }));
  await input.fill("@Ho");
  await expectAvatarShape(
    page.getByRole("option", { name: `Honey ${keys.human}`, exact: true }),
    "circle",
  );
  await expectAvatarShape(
    page.getByRole("option", {
      name: `Honey (agent) ${keys.agent}`,
      exact: true,
    }),
    "squircle",
  );
  await input.fill("");
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Mention a member or agent",
  });
  await expectAvatarShape(
    picker.getByRole("button", { name: `Honey ${keys.human}`, exact: true }),
    "circle",
  );
  await expectAvatarShape(
    picker.getByRole("button", {
      name: `Honey (agent) ${keys.agent}`,
      exact: true,
    }),
    "squircle",
  );
});
test("open completion republishes library-only display hints without changing the query", async ({
  page,
}) => {
  const input = await open(page);
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  // The shared naming provider retains library facts when this fixture mounts.
  // Opening completion must not create a second load owner.
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.libraryReads()))
    .toBe(1);
  await input.fill("@Ho");
  const first = page.getByRole("option", {
    name: new RegExp(keys.first),
  });
  const second = page.getByRole("option", {
    name: new RegExp(keys.second),
  });
  await expectAvatarShape(first, "circle");
  await expectAvatarShape(second, "squircle");
  // Completion observes the existing naming demand; it does not reload it.
  expect(await page.evaluate(() => window.mentionFixture.libraryReads())).toBe(
    1,
  );

  for (const [included, reads] of [
    [true, 2],
    [false, 3],
  ]) {
    await page.evaluate(
      (included) => window.mentionFixture.setLibraryAgent(included),
      included,
    );
    await expectAvatarShape(first, included ? "squircle" : "circle");
    await expectAvatarShape(second, "squircle");
    await expect(input).toHaveText("@Ho");
    await expect(input).toBeFocused();
    await expect(page.getByRole("listbox")).toBeVisible();
    expect(
      await page.evaluate(() => window.mentionFixture.libraryReads()),
    ).toBe(reads);
  }
});

for (const mode of ["light", "dark"]) {
  for (const kind of ["mention", "emoji"]) {
    test(`${mode} ${kind} keyboard selection is visible against its popup`, async ({
      page,
    }) => {
      const input = await open(page);
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      // Keep pointer hover from supplying a second highlight during keyboard use.
      await page.mouse.move(0, 0);
      await input.fill(kind === "mention" ? "@Ho" : ":smile");
      const popup = page.getByRole("region", {
        name: kind === "mention" ? "Mention suggestions" : "Emoji suggestions",
        exact: true,
      });
      const options = popup.getByRole("option");
      await expect(options.nth(1)).toBeVisible();
      if (kind === "mention") {
        await expect(popup).toHaveCSS("border-radius", "24px");
        await expect(popup).toHaveCSS("padding", "12px");
        await expect(popup).toHaveCSS("width", "380px");
        await expect(options.first()).toHaveCSS("padding", "8px");
        const composer = page.getByRole("form", {
          name: "Send a message to General",
        });
        await expect
          .poll(async () => {
            const anchor = await composer.boundingBox();
            const menu = await popup.boundingBox();
            return anchor.y - menu.y - menu.height;
          })
          .toBe(4);
      }
      await expect(options.first()).toHaveAttribute("aria-selected", "true");
      await input.press("ArrowDown");
      const selected = options.nth(1);
      await expect(selected).toHaveAttribute("aria-selected", "true");
      await expect(options.first()).toHaveAttribute("aria-selected", "false");
      await expect(input).toBeFocused();
      await expect(selected).toBeInViewport({ ratio: 1 });
      await expect(selected).toHaveCSS(
        "background-color",
        mode === "dark" ? "rgb(64, 64, 64)" : "rgb(239, 239, 240)",
      );
      const surface = await popup.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      await expect(selected).not.toHaveCSS("background-color", surface);
      await expect(options.first()).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      const replacement =
        kind === "emoji"
          ? await selected.locator("[data-native-emoji]").textContent()
          : "@Honey ";
      // Namesakes sort by their generated public keys, not fixture creation order.
      const recipient =
        kind === "mention"
          ? await selected.locator("small").textContent()
          : null;
      await input.press("Tab");
      await expect(input).toHaveJSProperty("value", replacement);
      await expect(input).toBeFocused();
      await expect(popup).toHaveCount(0);
      if (kind === "mention") {
        await input.press("Enter");
        await expect
          .poll(() =>
            page.evaluate(() =>
              window.mentionFixture.publications[0]?.tags.filter(
                ([tag]) => tag === "p",
              ),
            ),
          )
          .toEqual([["p", recipient]]);
      }
    });
  }
}

test("typeahead replaces only the query and publishes selected namesake identity, including replies", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const input = await open(page);
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  await input.fill("Before @Ho after");
  await input.evaluate((el) => {
    el.setSelectionRange(10, 10);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  const option = page.getByRole("option", {
    name: `Honey (agent) ${keys.second}`,
    exact: true,
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "Before @Honey  after");
  await expect(input.locator(".inline-chip")).toHaveCount(1);
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.mentionFixture.publications[0].tags.filter(([tag]) => tag === "p"),
    ),
  ).toEqual([["p", keys.second]]);
  await page.getByRole("button", { name: "Toggle thread" }).click();
  const reply = page.getByRole("textbox", { name: "Reply to thread" });
  await reply.fill("@Ho");
  await expect(
    page.getByRole("option", { name: `Honey ${keys.first}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: `Honey ${keys.first}`, exact: true })
    .click();
  await page.evaluate(() =>
    window.mentionFixture.change("disable", "buzz.mentions"),
  );
  await reply.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const sent = await page.evaluate(() => window.mentionFixture.publications[1]);
  expect(sent.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", keys.first]]);
  expect(errors.unexplained()).toEqual([]);
});
test("emoji keyboard, Escape, selected text, blur, IME and plugin disable preserve ordinary editing", async ({
  page,
}) => {
  const input = await open(page);
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "😄");
  await expect(input).toBeFocused();
  await input.press("Shift+ArrowLeft");
  await expect
    .poll(() =>
      input.evaluate((element) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    )
    .toEqual([0, "😄".length]);
  await input.press("ArrowRight");
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(0);
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.press("Shift+Enter");
  await expect(input).toHaveJSProperty("value", ":smile\n");
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input.evaluate((el) => {
    el.setSelectionRange(1, 4);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.fill(":smile");
  await input.evaluate((el) =>
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(0);
  await input.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.evaluate(() =>
    window.mentionFixture.change("disable", "buzz.emoji"),
  );
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", ":smile");
});
test("completion resumes after selection collapses to the original caret", async ({
  page,
}) => {
  const input = await open(page);
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Shift+ArrowLeft");
  await expect
    .poll(() => input.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([5, 6]);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.press("ArrowRight");
  await expect
    .poll(() => input.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([6, 6]);
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "😄");
  await expect(input).toBeFocused();
});
test("selection recovery requires fresh results and preserves Escape dismissal", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/typeahead.html");
  const input = page.getByRole("textbox", { name: "Message #Test" });
  const requests = () =>
    page.evaluate(() => window.completionFixture.queries().length);
  const publish = (index) =>
    page.evaluate(
      (index) =>
        window.completionFixture.publish(index, {
          items: [{ id: "choice", label: "Choice", edit: { text: "chosen" } }],
        }),
      index,
    );
  await input.fill("!selection");
  await expect.poll(requests).toBeGreaterThan(0);
  const before = await requests();
  expect(await publish(before - 1)).toBe(true);
  await expect(page.getByRole("option", { name: "Choice" })).toBeVisible();
  await input.press("Shift+ArrowLeft");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(await publish(before - 1)).toBe(false);
  await input.press("ArrowRight");
  await expect.poll(requests).toBeGreaterThan(before);
  expect(await publish(before - 1)).toBe(false);
  const after = await requests();
  expect(await publish(after - 1)).toBe(true);
  await expect(page.getByRole("option", { name: "Choice" })).toBeVisible();
  await input.press("Escape");
  // Redundant same-caret notifications must not undo deliberate dismissal.
  await input.evaluate((el) => {
    el.dispatchEvent(new Event("select", { bubbles: true }));
    el.ownerDocument.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(await requests()).toBe(after);
  expect(await publish(after - 1)).toBe(false);
  await expect(input).toHaveJSProperty("value", "!selection");
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});
test("editable composer exposes its listbox popup relationship only while suggestions are open", async ({
  page,
}) => {
  const input = await open(page);
  const attributes = [
    "aria-autocomplete",
    "aria-haspopup",
    "aria-controls",
    "aria-activedescendant",
  ];
  for (const attribute of attributes)
    await expect(input).not.toHaveAttribute(attribute);
  for (const close of ["escape", "accept", "blur", "disable"]) {
    await input.fill(":smile");
    const list = page.getByRole("listbox", { name: "Emoji suggestions" });
    await expect(list).toBeVisible();
    await expect(input).toHaveRole("textbox");
    await expect(input).toHaveAttribute("contenteditable", "true");
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
    await expect(input).toHaveAttribute("aria-haspopup", "listbox");
    await expect(input).toHaveAttribute(
      "aria-controls",
      await list.getAttribute("id"),
    );
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      await list.getByRole("option", { selected: true }).getAttribute("id"),
    );
    if (close === "escape") await input.press("Escape");
    else if (close === "accept") await input.press("Tab");
    else if (close === "blur") await input.evaluate((el) => el.blur());
    else
      await page.evaluate(() =>
        window.mentionFixture.change("disable", "buzz.emoji"),
      );
    await expect(list).toHaveCount(0);
    for (const attribute of attributes)
      await expect(input).not.toHaveAttribute(attribute);
    await expect(input).toHaveRole("textbox");
  }
});
test("plugin replacement, native blur and composer sessions revoke late publications", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/typeahead.html");
  const input = page.getByRole("textbox", { name: "Message #Test" });
  const latest = async () => {
    await expect
      .poll(() =>
        page.evaluate(() => window.completionFixture.queries().length),
      )
      .toBeGreaterThan(0);
    return page.evaluate(() => window.completionFixture.queries().length - 1);
  };
  const publish = (index, text = "chosen") =>
    page.evaluate(
      ({ index, text }) =>
        window.completionFixture.publish(index, {
          items: [{ id: text, label: text, edit: { text } }],
        }),
      { index, text },
    );
  await input.fill("!blur");
  const blurred = await latest();
  await page.getByRole("textbox", { name: "Message #Other" }).focus();
  expect(await publish(blurred)).toBe(false);
  await input.focus();
  const removed = await latest();
  await page.evaluate(() => window.completionFixture.change("disable"));
  expect(await publish(removed)).toBe(false);
  await page.evaluate(() => window.completionFixture.change("enable"));
  expect(await publish(removed)).toBe(false);
  await input.fill("!scope");
  const scoped = await latest();
  await page.getByRole("button", { name: "Switch session" }).click();
  expect(await publish(scoped)).toBe(false);
  await expect(
    page.getByRole("textbox", { name: "Message #Test" }),
  ).toHaveJSProperty("value", "");
});
test("selection follows IDs through reordering and rejected replacement never falls through to send", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/typeahead.html");
  const input = page.getByRole("textbox", { name: "Message #Test" });
  await input.fill("!order");
  await expect
    .poll(() => page.evaluate(() => window.completionFixture.queries().length))
    .toBeGreaterThan(0);
  const index = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  const publish = (items) =>
    page.evaluate(
      ({ index, items }) => window.completionFixture.publish(index, { items }),
      { index, items },
    );
  const a = { id: "a", label: "Alpha", edit: { text: "A" } },
    b = { id: "b", label: "Beta", edit: { text: "B" } };
  expect(await publish([b])).toBe(true);
  await expect(page.getByRole("option", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await publish([a, b])).toBe(true);
  await expect(page.getByRole("option", { name: "Alpha" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await publish([b, a])).toBe(true);
  await expect(page.getByRole("option").first()).toHaveText("Beta");
  await expect(page.getByRole("option", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", "B ");
  await input.fill("!limit");
  await expect
    .poll(() => page.evaluate(() => window.completionFixture.queries().at(-1)))
    .toBe("limit");
  const next = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  expect(
    await page.evaluate(
      (index) =>
        window.completionFixture.publish(index, {
          items: [
            {
              id: "long",
              label: "Too long",
              edit: { text: "x".repeat(16001) },
            },
          ],
        }),
      next,
    ),
  ).toBe(true);
  await expect(page.getByRole("option", { name: "Too long" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", "!limit");
  await expect(page.getByRole("alert")).toContainText("too long");
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});
test("emoji completion starts at the first ranked result when Unicode joins community matches", async ({
  page,
}, testInfo) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><circle cx="21" cy="21" r="20" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html");
  await page.mouse.move(0, 0);
  const input = page.getByRole("textbox", { name: "Message #general" });
  // Load the community catalog before starting a new query, as in a live composer.
  await input.fill(":enjoy");
  await expect(
    page.getByRole("option", { name: ":enjoy:", exact: true }),
  ).toBeVisible();
  for (const query of ["joy", "grin"]) {
    await input.fill(`:${query}`);
    const list = page.getByRole("listbox", { name: "Emoji suggestions" });
    const first = list.getByRole("option").first();
    await expect(first).toHaveAccessibleName(`:${query}:`);
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(list).toHaveJSProperty("scrollTop", 0);
    if (query === "joy")
      await page
        .getByRole("region", { name: "Emoji suggestions", exact: true })
        .screenshot({
          path: testInfo.outputPath("emoji-first-result.png"),
        });
    await input.press("Enter");
    await expect(input).toHaveJSProperty(
      "value",
      query === "joy" ? "😂" : "😁",
    );
  }
});

test("current custom catalog drives typeahead and signed tags across community replacement", async ({
  page,
}, testInfo) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><circle cx="21" cy="21" r="20" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  await input.fill(":very-long");
  const longOption = page.getByRole("option", {
    name: ":very-long-community-emoji-name-that-does-not-fit:",
    exact: true,
  });
  await expect(longOption).toBeVisible();
  const longLabel = longOption.locator("[data-completion-label]");
  await expect(longLabel).toHaveCSS("text-overflow", "ellipsis");
  await expect(longLabel).toHaveCSS("white-space", "nowrap");
  expect(
    await longLabel.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  const suggestions = page.getByRole("region", {
    name: "Emoji suggestions",
    exact: true,
  });
  await input.fill(":smile");
  const customSmile = page.getByRole("option", {
    name: ":smile: Community emoji",
    exact: true,
  });
  const unicodeSmile = page.getByRole("option", {
    name: ":smile: Unicode emoji",
    exact: true,
  });
  await expect(customSmile).toBeVisible();
  await expect(unicodeSmile).toBeVisible();
  await expect(customSmile.locator("small")).toBeHidden();
  await expect(unicodeSmile.locator("small")).toBeHidden();
  await input.fill(":party");
  const partyOptions = page.getByRole("option");
  await expect.poll(() => partyOptions.count()).toBeGreaterThan(1);
  const selectedParty = partyOptions.first();
  const hoveredParty = partyOptions.nth(1);
  await expect(selectedParty).toHaveAttribute("aria-selected", "true");
  await expect(suggestions).toHaveCSS("border-radius", "24px");
  await expect(selectedParty).toHaveCSS("border-radius", "18px");
  const nativeEmoji = partyOptions.locator("[data-native-emoji]").first();
  await expect(nativeEmoji).toBeVisible();
  expect(
    Math.abs(
      await nativeEmoji.evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(element).transform,
        );
        return matrix.m42;
      }),
    ),
  ).toBeLessThan(1);
  await suggestions.screenshot({
    path: testInfo.outputPath("emoji-completion-alignment.png"),
  });
  const verticallyCenteredContent = await partyOptions.evaluateAll((options) =>
    options.flatMap((option) => {
      const optionBounds = option.getBoundingClientRect();
      return Array.from(option.children).map((child) => {
        const childBounds = child.getBoundingClientRect();
        return {
          content: childBounds.top + childBounds.height / 2,
          option: optionBounds.top + optionBounds.height / 2,
        };
      });
    }),
  );
  expect(
    verticallyCenteredContent.every(
      ({ content, option }) => Math.abs(content - option) < 1,
    ),
  ).toBe(true);
  await expect(selectedParty).toHaveCSS("justify-content", "flex-start");
  await hoveredParty.hover();
  await expect(hoveredParty).toHaveAttribute("aria-selected", "true");
  await expect(selectedParty).not.toHaveAttribute("aria-selected", "true");
  await expect(hoveredParty).toHaveCSS(
    "background-color",
    "rgb(239, 239, 240)",
  );
  const partyList = page.getByRole("listbox", {
    name: "Emoji suggestions",
    exact: true,
  });
  const partiallyVisibleParty = partyOptions.last();
  const { scrollTop: scrollBeforeHover, hoverPoint } = await partyList.evaluate(
    (list, option) => {
      list.scrollTop = Math.max(
        0,
        option.offsetTop + option.offsetHeight / 2 - list.clientHeight,
      );
      const listBounds = list.getBoundingClientRect();
      const optionBounds = option.getBoundingClientRect();
      return {
        scrollTop: list.scrollTop,
        hoverPoint: {
          x: optionBounds.left + optionBounds.width / 2,
          y: Math.min(optionBounds.bottom - 1, listBounds.bottom - 1),
        },
      };
    },
    await partiallyVisibleParty.elementHandle(),
  );
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await expect(partiallyVisibleParty).toHaveAttribute("aria-selected", "true");
  expect(await partyList.evaluate((list) => list.scrollTop)).toBe(
    scrollBeforeHover,
  );
  await input.fill(":woman_kneeling");
  const kneelingEmoji = page
    .getByRole("option", { name: ":woman_kneeling:", exact: true })
    .locator("[data-native-emoji]");
  await expect(kneelingEmoji).toBeVisible();
  expect(
    await kneelingEmoji.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return matrix.m42;
    }),
  ).toBeLessThan(-0.5);
  await input.fill(":smirk");
  const smirkEmoji = page
    .getByRole("option", { name: ":smirk:", exact: true })
    .locator("[data-native-emoji]");
  await expect(smirkEmoji).toBeVisible();
  expect(
    Math.abs(
      await smirkEmoji.evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(element).transform,
        );
        return matrix.m42;
      }),
    ),
  ).toBeLessThan(1);
  await page.getByRole("option", { name: ":smirk:", exact: true }).click();
  await expect(input).toHaveJSProperty("value", "😏");
  expect(await input.evaluate((element) => element.selectionStart)).toBe(
    "😏".length,
  );
  await input.pressSequentially("hello");
  await expect(input).toHaveJSProperty("value", "😏hello");
  await input.fill(":party-par");
  const first = page.getByRole("option", {
    name: ":party-parrot:",
    exact: true,
  });
  await expect(first).toBeVisible();
  const composer = input.locator("xpath=ancestor::form");
  await expect(suggestions).not.toContainText("Community emoji");
  await expect(suggestions).not.toContainText("to navigate");
  const suggestionBox = await suggestions.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(suggestionBox.width).toBeCloseTo(composerBox.width * 0.375, 1);
  await first.click();
  await expect(input).toHaveJSProperty("value", ":party-parrot:");
  await expect(composer.locator("img[data-copy-emoji]")).toHaveCSS(
    "width",
    "42px",
  );
  await input.press("Shift+ArrowLeft");
  expect(
    await input.evaluate((element) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    ),
  ).toBe(":party-parrot:");
  await input.press("ArrowRight");
  expect(await input.evaluate((element) => element.selectionStart)).toBe(
    ":party-parrot:".length,
  );
  await expect(input).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("custom-emoji-native-caret.png"),
    caret: "initial",
  });
  await page.evaluate(() => window.emojiFixture.remove());
  await expect(input).toHaveJSProperty("value", ":party-parrot:");
  await page.evaluate(() => window.emojiFixture.replace());
  await input.press("Backspace");
  await expect(input).toHaveJSProperty("value", "");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", ":party-parrot:");
  // macOS End scrolls the document; use its caret shortcut when overscroll is off.
  await input.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  await input.pressSequentially(" hello");
  await expect(input).toHaveJSProperty("value", ":party-parrot: hello");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => window.emojiFixture.report.publications[0].event.tags,
    ),
  ).toContainEqual([
    "emoji",
    "party-parrot",
    "https://a.test/media/parrot.png",
  ]);
  expect(
    await page.evaluate(
      () => window.emojiFixture.report.publications[0].event.content,
    ),
  ).toBe(":party-parrot: hello");
  await input.fill(":party-parrot:");
  await expect(input).toHaveAttribute("data-single-emoji", "true");
  const renderedEmoji = input.locator("img[data-copy-emoji]");
  await expect(renderedEmoji).toHaveCount(1);
  await expect(renderedEmoji).toHaveCSS("width", "42px");
  await expect(renderedEmoji).toHaveCSS("height", "42px");
  await input.evaluate((element) => {
    const pasted = element.value.repeat(2);
    element.setSelectionRange(0, element.value.length);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect(input).toHaveJSProperty("value", ":party-parrot::party-parrot:");
  await expect(input).toHaveAttribute("data-single-emoji", "true");
  await expect(renderedEmoji).toHaveCount(2);
  for (const image of await renderedEmoji.all()) {
    await expect(image).toHaveCSS("width", "42px");
    await expect(image).toHaveCSS("height", "42px");
  }
  await input.fill(":party-parrot:lakjsdlkjflakjsdf");
  await expect(input.locator("[data-source]")).toHaveCount(1);
  await expect(input).not.toHaveAttribute("data-single-emoji", "true");
  await expect(renderedEmoji).toHaveCount(1);
  await expect(renderedEmoji).toHaveCSS("width", "22px");
  await expect(renderedEmoji).toHaveCSS("height", "22px");
  await expect(composer).toContainText("lakjsdlkjflakjsdf");
  const inlineAlignment = await input.evaluate((element) => {
    const token = element.querySelector("[data-source]");
    const range = document.createRange();
    range.selectNodeContents(token.nextSibling);
    return {
      right: token.getBoundingClientRect().right,
      textLeft: range.getBoundingClientRect().left,
    };
  });
  expect(inlineAlignment.textLeft).toBeCloseTo(inlineAlignment.right, 0);
  await input.fill("hello :party");
  await page.getByRole("option", { name: ":party:", exact: true }).click();
  await expect(input).toHaveJSProperty("value", "hello :party:");
  await input.fill(":party");
  await expect(
    page.getByRole("option", { name: ":party:", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remove());
  await expect(
    page.getByRole("option", { name: ":party:", exact: true }),
  ).toHaveCount(0);
  await input.press("Escape");
  await page.getByRole("button", { name: "Switch community" }).click();
  await input.fill(":party");
  await page.getByRole("option", { name: ":party:", exact: true }).click();
  await expect(input).toHaveJSProperty("value", ":party:");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () => window.emojiFixture.report.publications[1].event.tags,
    ),
  ).toContainEqual(["emoji", "party", "https://b.test/media/1.png"]);
});

test("mention choices survive unrelated list updates but revoke removed membership", async ({
  page,
}) => {
  const input = await open(page);
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  await input.fill("@Ho");
  const first = page.getByRole("option", {
    name: `Honey ${keys.first}`,
    exact: true,
  });
  const second = page.getByRole("option", {
    name: `Honey ${keys.second}`,
    exact: true,
  });
  await expect(first).toBeVisible();
  await page.evaluate(() => window.mentionFixture.refresh());
  await expect(first).toBeVisible();
  await page.evaluate(() => window.mentionFixture.otherMessage());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.list().channels.find((c) => c.id === "other")
            ?.preview,
      ),
    )
    .toBe("Unrelated preview");
  await expect(first).toBeVisible();
  await page.evaluate(() => window.mentionFixture.removeFirst());
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await second.click();
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.mentionFixture.publications[0].tags.filter(([tag]) => tag === "p"),
    ),
  ).toEqual([["p", keys.second]]);
});

test("cold multi-word mention query wakes when profiles arrive without another keystroke", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?delayed-profiles");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("@Mary J");
  await expect(page.getByRole("option", { name: /^Mary Jane / })).toHaveCount(
    0,
  );
  await page.evaluate(() => window.mentionFixture.releaseProfiles());
  const choice = page.getByRole("option", { name: /^Mary Jane / });
  await expect(choice).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", "@Mary Jane ");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("recovery is a keyboard-selectable action without transferring editor focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/typeahead.html");
  const input = page.getByRole("textbox", { name: "Message #Test" });
  for (const withChoice of [false, true]) {
    await input.fill(`!retry-${withChoice}`);
    // fill() finishes before React necessarily mounts the next provider. Wait
    // for this query, not whichever historical request happened to be last.
    await expect
      .poll(() =>
        page.evaluate(() => window.completionFixture.queries().at(-1)),
      )
      .toBe(`retry-${withChoice}`);
    const index = await page.evaluate(
      () => window.completionFixture.queries().length - 1,
    );
    expect(
      await page.evaluate(
        ({ index, withChoice }) =>
          window.completionFixture.fail(index, withChoice),
        { index, withChoice },
      ),
    ).toBe(true);
    const retry = page.getByRole("option", { name: "Retry suggestions" });
    // Publishing updates React state; wait for the options and keyboard handler
    // to commit before ArrowUp, or the browser moves the caret instead.
    await expect(retry).toBeVisible();
    if (withChoice) await input.press("ArrowUp");
    await expect(retry).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
    await expect(page.getByRole("option", { name: "Recovered" })).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveJSProperty("value", `!retry-${withChoice}`);
    await input.press("Tab");
    await expect(input).toHaveJSProperty("value", "recovered ");
  }
  expect(await page.evaluate(() => window.completionFixture.retries())).toBe(2);
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});

test("channel and actual ThreadPanel composers keep separate completion and draft ownership", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 520 });
  await page.goto("/tests/fixtures/messages.html");
  const main = page.getByRole("textbox", { name: "Message #one" });
  const thread = page.getByRole("textbox", { name: "Reply to thread" });
  await expect(thread).toBeVisible();
  await main.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  const mainControls = await main.getAttribute("aria-controls");
  await thread.fill("@Fixture");
  const option = page.getByRole("option", { name: /^Fixture Reader / });
  await expect(option).toBeVisible();
  await expect(main).not.toHaveAttribute("aria-controls");
  expect(await thread.getAttribute("aria-controls")).not.toBe(mainControls);
  await option.click();
  await expect(thread).toBeFocused();
  await expect(thread).toHaveJSProperty("value", "@Fixture Reader ");
  await expect(main).toHaveJSProperty("value", ":smile");
  await main.focus();
  await expect(main).toHaveJSProperty("selectionStart", 6);
  await expect(main).toHaveJSProperty("selectionEnd", 6);
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await main.press("Tab");
  await expect(main).toHaveJSProperty("value", "😄");
  await expect(thread).toHaveJSProperty("value", "@Fixture Reader ");
});

test("native read-only state rejects a displayed choice without sending", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/typeahead.html");
  const input = page.getByRole("textbox", { name: "Message #Test" });
  await input.fill("!readonly");
  const current = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  await page.evaluate(
    (index) =>
      window.completionFixture.publish(index, {
        items: [{ id: "bad", label: "Bad", edit: { text: "bad" } }],
      }),
    current,
  );
  await expect(page.getByRole("option", { name: "Bad" })).toBeVisible();
  await input.evaluate((el) => {
    el.readOnly = true;
  });
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", "!readonly");
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});

test("a later emoji trigger wins after a mention without discarding recipient intent", async ({
  page,
}) => {
  const input = await open(page);
  const key = await page.evaluate(() => window.mentionFixture.first);
  await input.fill("@Ho");
  await page.getByRole("option", { name: `Honey ${key}`, exact: true }).click();
  await input.pressSequentially(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "@Honey 😄");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.mentionFixture.publications[0].tags.filter(([tag]) => tag === "p"),
    ),
  ).toEqual([["p", key]]);
  await input.fill("@Honey :smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "@Honey 😄");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
});

test("portal bounds hold when the focused composer moves outside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 300 });
  await page.goto("/tests/fixtures/typeahead.html");
  const input = page.getByRole("textbox", { name: "Message #Test" });
  await input.fill("!geometry");
  await expect
    .poll(() => page.evaluate(() => window.completionFixture.queries().at(-1)))
    .toBe("geometry");
  const index = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  await page.evaluate(
    (index) =>
      window.completionFixture.publish(index, {
        items: Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          label: `Choice ${i}`,
          edit: { text: `choice-${i}` },
        })),
      }),
    index,
  );
  const popup = page.getByRole("region", { name: "Delayed suggestions" });
  await expect(popup).toBeVisible();
  for (const y of [2000, -2000, 0]) {
    await input.evaluate((el, y) => {
      el.closest("form").style.transform = `translateY(${y}px)`;
      window.dispatchEvent(new Event("resize"));
    }, y);
    await expect
      .poll(() =>
        popup.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const viewport = window.visualViewport;
          return (
            r.top >= viewport.offsetTop &&
            r.bottom <= viewport.offsetTop + viewport.height
          );
        }),
      )
      .toBe(true);
    await expect(input).toBeFocused();
  }
});
