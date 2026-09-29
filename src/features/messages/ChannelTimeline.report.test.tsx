// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactElement, type ReactNode } from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import {
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { ChannelTimeline } from "./ChannelTimeline";

// Virtualizer boundary: render only "visible" indices plus `keepMounted`,
// as Virtua does for rows scrolled out of its buffer. Layout is browser-tested.
const view = vi.hoisted(() => ({
  visible: undefined as ReadonlySet<number> | undefined,
}));
vi.mock("virtua", async () => {
  const { Children, forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        keepMounted = [],
      }: { children: ReactNode; keepMounted?: readonly number[] },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return (
        <ol>
          {Children.toArray(children).map((child, index) =>
            !view.visible ||
            view.visible.has(index) ||
            keepMounted.includes(index) ? (
              <li key={(child as ReactElement).key}>{child}</li>
            ) : null,
          )}
        </ol>
      );
    }),
  };
});

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const target = message(other, "c", "Report me", 1);
const neighbor = message(other, "c", "Neighbor", 2);
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  view.visible = undefined;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(publish: (event: RelayEvent) => Promise<void>) {
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live?.receive([roster(relay, "c", [viewer.pubkey], 1), target, neighbor]);
  const tree = () => (
    <StrictMode>
      <ToastProvider>
        <ChannelTimeline
          channelId="c"
          scope="viewer"
          queries={owner.session}
          window={owner.session.channels.window("c")}
          onOpenLink={() => false}
        />
      </ToastProvider>
    </StrictMode>
  );
  const result = render(tree());
  const row = () =>
    document.querySelector<HTMLElement>(`[data-message-id="${target.id}"]`);
  const neighborRow = () =>
    document.querySelector(`[data-message-id="${neighbor.id}"]`);
  return {
    row,
    neighborRow,
    // Scroll the target out of the virtualizer buffer.
    evict() {
      const index = owner.session.channels
        .window("c")
        .rows.findIndex((row) => row.id === neighbor.id);
      view.visible = new Set([index]);
      result.rerender(tree());
    },
    show() {
      view.visible = undefined;
      result.rerender(tree());
    },
    unmount: result.unmount,
  };
}

async function openReport(row: HTMLElement) {
  const user = userEvent.setup();
  const trigger = within(row).getByRole("button", {
    name: "More message actions",
  });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  await screen.findByRole("dialog", { name: "Report message" });
  return { user, trigger };
}

it("keeps the reporting row mounted through a held submission and its notice, then releases it", async () => {
  let settle!: () => void;
  const publish = vi.fn(
    () => new Promise<void>((resolve) => (settle = resolve)),
  );
  const h = mount(publish);
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const { user } = await openReport(row);
  h.evict();
  expect(h.neighborRow()).not.toBeNull();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("radio", { name: "Spam" }));
  await user.type(
    screen.getByRole("textbox", { name: "Additional context (optional)" }),
    "repeated links",
  );
  await user.click(screen.getByRole("button", { name: "Submit report" }));
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  h.evict();
  expect(h.row()).toBe(row);
  act(() => settle());
  expect(
    await screen.findByText("Report submitted to community moderators"),
  ).toBeTruthy();
  h.evict();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("button", { name: /dismiss/i }));
  // Once the notice and focus are gone, the virtualizer may evict the row.
  await waitFor(() => expect(h.row()).toBeNull());
  expect(h.neighborRow()).not.toBeNull();
});

it("releases on cancel, pins again on reopen, and unmounts cleanly while open", async () => {
  const error = vi.spyOn(console, "error");
  const h = mount(async () => {});
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const { user, trigger } = await openReport(row);
  await user.click(screen.getByRole("radio", { name: "Other" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await openReport(row);
  expect(
    screen.getByRole("radio", { name: "Other" }).getAttribute("aria-checked"),
  ).toBe("false");
  h.evict();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  // Restored focus keeps the row; once focus leaves, the pin must be gone.
  act(() => trigger.blur());
  h.evict();
  await waitFor(() => expect(h.row()).toBeNull());

  h.show();
  const remounted = h.row();
  if (!remounted) throw new Error("Missing target row");
  await openReport(remounted);
  h.unmount();
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull();
  expect(error).not.toHaveBeenCalled();
});
