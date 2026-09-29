// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import {
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { MessageRow } from "./MessageRow";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, "c", "Report me", 1);
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

let focusedAtRelease: Element | null = null;
const release = vi.fn(() => {
  focusedAtRelease = document.activeElement;
});
const keepMounted = vi.fn((_id: string) => release);
afterEach(() => {
  focusedAtRelease = null;
  release.mockClear();
  keepMounted.mockClear();
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
  live?.receive([roster(relay, "c", [viewer.pubkey], 1), root]);
  const row = owner.session.channels.window("c").rows[0];
  if (!row) throw new Error("Missing row");
  render(
    <MessageRow
      row={row}
      session={owner.session}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      keepMounted={keepMounted}
    />,
    { wrapper: ToastProvider },
  );
}

it("reports from the message menu, keeps input after failure and confirms success", async () => {
  const user = userEvent.setup();
  let settle!: (error?: Error) => void;
  const publish = vi.fn(
    (_event: RelayEvent) =>
      new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      }),
  );
  mount(publish);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  const dialog = await screen.findByRole("dialog", { name: "Report message" });
  // A virtualized list must not evict the row owning the draft and outcome.
  expect(keepMounted.mock.calls).toEqual([[root.id]]);
  const submit = screen.getByRole("button", { name: "Submit report" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("radio", { name: "Spam" }));
  await user.type(
    screen.getByRole("textbox", { name: "Additional context (optional)" }),
    "repeated links",
  );
  await user.click(submit);
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  expect(submit.getAttribute("aria-busy")).toBe("true");
  expect(
    screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
  ).toBe(true);
  settle(new PublishRejected("blocked"));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Failed to submit report",
  );
  expect(dialog.isConnected).toBe(true);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Additional context (optional)",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("repeated links");
  await user.click(submit);
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  expect(publish.mock.calls[1]?.[0]).toMatchObject({
    kind: 1984,
    content: "repeated links",
    tags: [
      ["p", other.pubkey],
      ["e", root.id, "spam"],
    ],
  });
  settle();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull(),
  );
  expect(
    await screen.findByText("Report submitted to community moderators"),
  ).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(release).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /dismiss/i }));
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(keepMounted).toHaveBeenCalledOnce();
});

it("starts each report with an empty form", async () => {
  const user = userEvent.setup();
  mount(async () => {});
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  await user.click(await screen.findByRole("radio", { name: "Other" }));
  expect(keepMounted.mock.calls).toEqual([[root.id]]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull(),
  );
  // Restored focus must reach the row before its pin is released.
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(focusedAtRelease).toBe(trigger);
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  expect(
    (
      (await screen.findByRole("radio", { name: "Other" })) as HTMLElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
});
