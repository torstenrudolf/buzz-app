// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenuRoot, MenuPopup } from "../../shared/design-system/ui/Menu";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { ChannelLifecycleDialog } from "./ChannelLifecycleDialog";
import type { ChannelLifecycleSettings } from "../../features/relay/channel-lifecycle-protocol";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const settings: ChannelLifecycleSettings = {
  channelId: "id",
  channelType: "stream",
  canArchive: true,
  canDelete: true,
  canLeave: false,
  canHide: false,
  leaveReason: "Transfer ownership before leaving the channel.",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function capability() {
  return {
    available: true,
    load: vi.fn(async () => settings),
    run: vi.fn<ChannelLifecycleCapability["run"]>(async () => {}),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
}
it("waits silently for fresh permissions and preserves the last-owner boundary", async () => {
  const user = userEvent.setup();
  const lifecycle = capability();
  const choose = vi.fn();
  const gate = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(gate.promise);
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channelId="id"
          lifecycle={lifecycle}
          choose={choose}
          disabled={false}
          separator
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  await waitFor(() => expect(lifecycle.load).toHaveBeenCalledOnce());
  expect(screen.queryByText("Checking channel permissions…")).toBeNull();
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  expect(screen.queryByRole("separator")).toBeNull();
  expect(choose).not.toHaveBeenCalled();
  gate.resolve(settings);
  const remove = await screen.findByRole("menuitem", {
    name: "Delete channel",
  });
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(screen.queryByRole("menuitem", { name: /^Leave channel/ })).toBeNull();
  expect(
    screen.queryByText("Transfer ownership before leaving the channel."),
  ).toBeNull();
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Archive channel", "Delete channel"]);
  for (const name of ["Archive channel", "Delete channel"]) {
    const item = screen.getByRole("menuitem", { name });
    expect(
      item.querySelector('.buzz-menu-icon[aria-hidden="true"] svg'),
    ).not.toBeNull();
  }
  await user.click(remove);
  expect(choose).toHaveBeenCalledWith("delete");
});
it.each([
  { action: "leave", label: "Leave channel", channelType: "stream" },
  { action: "hide", label: "Hide conversation", channelType: "dm" },
] as const)(
  "offers $label without an ellipsis when permitted",
  async ({ action, label, channelType }) => {
    const user = userEvent.setup();
    const lifecycle = capability();
    lifecycle.load.mockResolvedValue({
      channelId: "id",
      channelType,
      canArchive: false,
      canDelete: false,
      canLeave: action === "leave",
      canHide: action === "hide",
    });
    const choose = vi.fn();
    render(
      <ContextMenuRoot open>
        <MenuPopup>
          <ChannelLifecycleMenu
            channelId="id"
            lifecycle={lifecycle}
            choose={choose}
            disabled={false}
            separator
          />
        </MenuPopup>
      </ContextMenuRoot>,
    );
    const item = await screen.findByRole("menuitem", {
      name: label,
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(
      item.querySelector('.buzz-menu-icon[aria-hidden="true"] svg'),
    ).not.toBeNull();
    await user.click(item);
    expect(choose).toHaveBeenCalledWith(action);
  },
);
it("failed permission reads offer retry rather than stale destructive actions", async () => {
  const user = userEvent.setup();
  const lifecycle = capability();
  lifecycle.load.mockRejectedValueOnce(
    new Error("Malformed channel membership state"),
  );
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channelId="id"
          lifecycle={lifecycle}
          choose={() => {}}
          disabled={false}
          separator
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Channel actions unavailable",
  );
  expect(
    screen.queryByRole("menuitem", { name: "Archive channel" }),
  ).toBeNull();
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  const retry = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(retry.promise);
  await user.click(
    screen.getByRole("menuitem", { name: "Retry channel permissions" }),
  );
  await waitFor(() => expect(lifecycle.load).toHaveBeenCalledTimes(2));
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  expect(screen.queryByRole("separator")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  retry.resolve(settings);
  expect(
    await screen.findByRole("menuitem", {
      name: "Archive channel",
    }),
  ).toBeDefined();
  expect(screen.getAllByRole("separator")).toHaveLength(1);
});
it.each([
  { separator: false, allowed: true },
  { separator: true, allowed: false },
])("omits an orphan separator: %j", async ({ separator, allowed }) => {
  const lifecycle = capability();
  const gate = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(gate.promise);
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channelId="id"
          lifecycle={lifecycle}
          choose={() => {}}
          disabled={false}
          separator={separator}
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  await waitFor(() => expect(lifecycle.load).toHaveBeenCalledOnce());
  await act(async () => {
    gate.resolve({ ...settings, canArchive: allowed, canDelete: allowed });
    await gate.promise;
  });
  expect(screen.queryAllByRole("menuitem")).toHaveLength(allowed ? 2 : 0);
  expect(screen.queryByRole("separator")).toBeNull();
});
it("keeps the unavailable section separated without loading permissions", async () => {
  const lifecycle = { ...capability(), available: false };
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channelId="id"
          lifecycle={lifecycle}
          choose={() => {}}
          disabled={false}
          separator
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  expect(
    await screen.findByRole("menuitem", {
      name: "Channel actions unavailable on this connection",
    }),
  ).toBeDefined();
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(lifecycle.load).not.toHaveBeenCalled();
});
it("confirmation, pending lockout and failed-write recovery stay in the actual dialog", async () => {
  // jsdom does not implement top-layer focus; that contract is covered in browsers.
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  const user = userEvent.setup();
  const lifecycle = capability();
  const completed = vi.fn();
  const close = vi.fn();
  const gate = deferred<void>();
  lifecycle.run.mockImplementationOnce(() =>
    gate.promise.then(() => {
      throw new Error("relay rejected");
    }),
  );
  render(
    <ChannelLifecycleDialog
      channelId="id"
      channelName="Fixture"
      action="delete"
      lifecycle={lifecycle}
      completed={completed}
      close={close}
    />,
  );
  const confirm = screen.getByRole("button", {
    name: "Delete channel",
  }) as HTMLButtonElement;
  expect(confirm.getAttribute("data-variant")).toBe("destructive");
  expect(confirm.disabled).toBe(false);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "Delete channel: Fixture" }),
  ).toBeDefined();
  expect(
    screen.getByText(
      "Delete this channel for everyone. You cannot undo this action from Buzz.",
    ),
  ).toBeDefined();
  expect(lifecycle.run).not.toHaveBeenCalled();
  await user.click(confirm);
  await waitFor(() => expect(lifecycle.run).toHaveBeenCalledOnce());
  expect(confirm.disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  gate.resolve();
  expect((await screen.findByRole("alert")).textContent).toBe("relay rejected");
  expect(completed).not.toHaveBeenCalled();
  expect(confirm.disabled).toBe(false);
  await user.click(confirm);
  await waitFor(() => expect(completed).toHaveBeenCalledOnce());
});

it.each(["leave", "hide", "archive"] as const)(
  "%s requires confirmation and ignores completion after unmount",
  async (action) => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    const lifecycle = capability();
    const gate = deferred<void>();
    lifecycle.run.mockImplementationOnce(() => gate.promise);
    const completed = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action={action}
        lifecycle={lifecycle}
        close={() => {}}
        completed={completed}
      />,
    );
    expect(lifecycle.run).not.toHaveBeenCalled();
    const label = {
      leave: "Leave channel",
      hide: "Hide conversation",
      archive: "Archive channel",
    }[action];
    const confirm = screen.getByRole("button", { name: label });
    expect(confirm.getAttribute("data-variant")).toBe("prominent");
    if (action === "archive") {
      expect(
        screen.getByText(
          "Archive this channel for everyone and remove it from the sidebar. Messages are kept. A channel administrator can unarchive it later using another supported client; this app cannot restore it yet.",
        ),
      ).toBeDefined();
    }
    await user.click(confirm);
    expect(lifecycle.run).toHaveBeenCalledWith(
      action,
      "id",
      expect.any(AbortSignal),
    );
    const signal = vi.mocked(lifecycle.run).mock.calls[0]?.[2];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await gate.promise;
    expect(completed).not.toHaveBeenCalled();
  },
);
it("uncertain delivery keeps the dialog recoverable without offering blind resubmission", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  const lifecycle = capability();
  lifecycle.run.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed("connection lost"),
  );
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelLifecycleDialog
      channelId="id"
      channelName="Fixture"
      action="leave"
      lifecycle={lifecycle}
      close={close}
      completed={() => {}}
    />,
  );
  const confirm = screen.getByRole("button", {
    name: "Leave channel",
  }) as HTMLButtonElement;
  await user.click(confirm);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "may have taken effect",
  );
  expect(confirm.disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(lifecycle.run).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "Delete outage preserves sidebar Archive=%s and Leave, then retries",
  async (canArchive) => {
    const lifecycle = capability(),
      choose = vi.fn();
    lifecycle.load.mockResolvedValueOnce({
      ...settings,
      canArchive,
      canLeave: true,
      canDelete: false,
      deleteUnavailable: true,
    });
    render(
      <ContextMenuRoot open>
        <MenuPopup>
          <ChannelLifecycleMenu
            channelId="id"
            lifecycle={lifecycle}
            choose={choose}
            disabled={false}
            separator
          />
        </MenuPopup>
      </ContextMenuRoot>,
    );
    expect(
      await screen.findByRole("menuitem", {
        name: "Delete check unavailable",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Leave channel" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(!!screen.queryByRole("menuitem", { name: "Archive channel" })).toBe(
      canArchive,
    );
    expect(
      screen.queryByRole("menuitem", { name: "Delete channel" }),
    ).toBeNull();
    lifecycle.load.mockResolvedValue({
      ...settings,
      canArchive,
      canLeave: true,
    });
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "Retry Delete check" }));
    expect(
      await screen.findByRole("menuitem", { name: "Delete channel" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("Delete check unavailable")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  },
);
