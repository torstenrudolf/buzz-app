import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import { SettingsCardsService } from "./service";

it("retains visibility for cards activated after Settings mounts", async () => {
  const root = new Context();
  const statusListeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe(listener: () => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  });
  const cards = new SettingsCardsService(root);
  const releaseVisibility = cards.retainVisibility();
  let visible = false;
  const visibilityListeners = new Set<() => void>();
  const release = vi.fn();
  const ensure = vi.fn(() => {
    visible = true;
    for (const listener of visibilityListeners) listener();
    return release;
  });
  const scope = root.extend({
    pluginOwner: { id: "moderation", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    ctx.settingsCards.register({
      id: "membership",
      title: "Membership",
      section: "administration",
      visibility: {
        snapshot: () => visible,
        subscribe(listener) {
          visibilityListeners.add(listener);
          return () => visibilityListeners.delete(listener);
        },
        ensure,
      },
      component: () => null,
    });
  });
  await fiber.await();
  await flush();

  expect(ensure).toHaveBeenCalledOnce();
  expect(cards.snapshot().map((card) => card.key)).toEqual([
    "moderation/membership",
  ]);

  await fiber.dispose();
  expect(release).toHaveBeenCalledOnce();
  releaseVisibility();
  await root.fiber.dispose();
});

it("notifies route readers when hidden visibility settles without changing visible cards", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  let value: boolean | "pending" | "error" = "pending";
  let changed = () => {};
  const fiber = root
    .extend({ pluginOwner: { id: "moderation", revision: "one" } })
    .plugin((ctx) => {
      ctx.settingsCards.register({
        id: "membership",
        title: "Membership",
        component: () => null,
        visibility: {
          snapshot: () => value,
          subscribe(listener) {
            changed = listener;
            return () => {};
          },
          ensure: () => () => {},
        },
      });
    });
  await fiber.await();
  await flush();
  const notify = vi.fn();
  const stop = cards.subscribe(notify);
  const empty = cards.snapshot();
  expect(cards.visibility("moderation/membership")).toBe("pending");
  for (const next of ["error", false, true] as const) {
    value = next;
    changed();
    expect(cards.visibility("moderation/membership")).toBe(next);
    if (next !== true) expect(cards.snapshot()).toBe(empty);
  }
  expect(notify).toHaveBeenCalledTimes(3);
  expect(cards.snapshot()).toHaveLength(1);
  stop();
  await root.fiber.dispose();
});
