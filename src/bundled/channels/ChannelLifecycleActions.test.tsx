// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type { ChannelLifecycleSettings } from "../../features/relay/channel-lifecycle-protocol";
import { ChannelLifecycleActions } from "./ChannelLifecycleActions";

afterEach(cleanup);
const settings: ChannelLifecycleSettings = {
  channelId: "11111111-1111-4111-8111-111111111111",
  channelType: "stream",
  canLeave: true,
  canArchive: false,
  canDelete: false,
  canHide: false,
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
    load: vi.fn<ChannelLifecycleCapability["load"]>(async () => settings),
    run: vi.fn<ChannelLifecycleCapability["run"]>(),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
}
it("waits for fresh permission then hands the trigger to the existing confirmation, without writing", async () => {
  const lifecycle = capability();
  const gate = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(gate.promise);
  const choose = vi.fn();
  render(
    <ChannelLifecycleActions
      channelId="11111111-1111-4111-8111-111111111111"
      lifecycle={lifecycle}
      choose={choose}
    />,
  );
  await waitFor(() => expect(lifecycle.load).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => gate.resolve(settings));
  const button = screen.getByRole("button", {
    name: "Leave channel",
  });
  const user = userEvent.setup();
  button.focus();
  await user.keyboard("{Enter}");
  expect(choose).toHaveBeenCalledWith("leave", button);
  expect(lifecycle.run).not.toHaveBeenCalled();
});
it("omits forbidden Leave rather than an ownership-transfer explanation", async () => {
  const lifecycle = capability();
  lifecycle.load.mockResolvedValue({
    ...settings,
    canLeave: false,
    leaveReason: "Transfer ownership before leaving the channel.",
  });
  const mounted = render(
    <ChannelLifecycleActions
      channelId="11111111-1111-4111-8111-111111111111"
      lifecycle={lifecycle}
      choose={vi.fn()}
    />,
  );
  await act(async () => {});
  expect(mounted.container).toBeEmptyDOMElement();
});
it("keeps unavailable permission checks distinct from forbidden and offers explicit retry", async () => {
  const lifecycle = capability();
  lifecycle.load.mockRejectedValueOnce(new Error("Malformed state"));
  render(
    <ChannelLifecycleActions
      channelId="11111111-1111-4111-8111-111111111111"
      lifecycle={lifecycle}
      choose={vi.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Channel actions unavailable",
  );
  const gate = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(gate.promise);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry channel permissions" }));
  await waitFor(() => expect(lifecycle.load).toHaveBeenCalledTimes(2));
  expect(
    screen.getByRole("button", { name: "Retry channel permissions" }),
  ).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Retry channel permissions" }),
  ).toHaveAttribute("aria-busy", "true");
  await act(async () => gate.resolve(settings));
  expect(
    await screen.findByRole("button", { name: "Leave channel" }),
  ).toBeEnabled();
});
it("explains an unsupported host without starting a lookup or write", () => {
  const lifecycle = { ...capability(), available: false };
  render(
    <ChannelLifecycleActions
      channelId="11111111-1111-4111-8111-111111111111"
      lifecycle={lifecycle}
      choose={vi.fn()}
    />,
  );
  expect(
    screen.getByText("Channel actions unavailable on this connection"),
  ).toBeVisible();
  expect(lifecycle.load).not.toHaveBeenCalled();
  expect(lifecycle.run).not.toHaveBeenCalled();
});
it("fences permissions from a replaced channel, capability, or unmounted pane", async () => {
  const lifecycle = capability();
  const old = deferred<ChannelLifecycleSettings>();
  const next = deferred<ChannelLifecycleSettings>();
  lifecycle.load
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(next.promise);
  const choose = vi.fn();
  const mounted = render(
    <ChannelLifecycleActions
      channelId="11111111-1111-4111-8111-111111111111"
      lifecycle={lifecycle}
      choose={choose}
    />,
  );
  const signal = lifecycle.load.mock.calls[0]?.[1];
  mounted.rerender(
    <ChannelLifecycleActions
      channelId="22222222-2222-4222-8222-222222222222"
      lifecycle={lifecycle}
      choose={choose}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    old.resolve({ ...settings, canArchive: true, canDelete: true }),
  );
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () =>
    next.resolve({
      ...settings,
      channelId: "22222222-2222-4222-8222-222222222222",
    }),
  );
  expect(screen.getByRole("button", { name: "Leave channel" })).toBeEnabled();
  const replacement = capability();
  const held = deferred<ChannelLifecycleSettings>();
  replacement.load.mockReturnValueOnce(held.promise);
  mounted.rerender(
    <ChannelLifecycleActions
      channelId="22222222-2222-4222-8222-222222222222"
      lifecycle={replacement}
      choose={choose}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  const pending = replacement.load.mock.calls[0]?.[1];
  mounted.unmount();
  expect(pending?.aborted).toBe(true);
  await act(async () => held.resolve(settings));
  expect(choose).not.toHaveBeenCalled();
});

it.each([
  { role: "last owner", canLeave: false, canArchive: true, canDelete: true },
  {
    role: "owner with another owner",
    canLeave: true,
    canArchive: true,
    canDelete: true,
  },
  { role: "admin", canLeave: true, canArchive: true, canDelete: false },
  { role: "member", canLeave: true, canArchive: false, canDelete: false },
  {
    role: "archived owner",
    canLeave: false,
    canArchive: false,
    canDelete: false,
  },
  {
    role: "no permitted actions",
    canLeave: false,
    canArchive: false,
    canDelete: false,
  },
])(
  "uses independent action permissions from one read: $role",
  async ({ canLeave, canArchive, canDelete }) => {
    const lifecycle = capability();
    const gate = deferred<ChannelLifecycleSettings>();
    lifecycle.load.mockReturnValueOnce(gate.promise);
    const choose = vi.fn();
    render(
      <ChannelLifecycleActions
        channelId={settings.channelId}
        lifecycle={lifecycle}
        choose={choose}
      />,
    );
    await waitFor(() => expect(lifecycle.load).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () =>
      gate.resolve({ ...settings, canLeave, canArchive, canDelete }),
    );
    const user = userEvent.setup();
    for (const [action, label, permitted] of [
      ["leave", "Leave channel", canLeave],
      ["archive", "Archive channel", canArchive],
      ["delete", "Delete channel", canDelete],
    ] as const) {
      const button = screen.queryByRole("button", { name: label });
      if (permitted) {
        expect(button).toBeEnabled();
        expect(button).toHaveAttribute(
          "data-variant",
          action === "delete" ? "destructive" : "subtle",
        );
        await user.click(screen.getByRole("button", { name: label }));
        expect(choose).toHaveBeenLastCalledWith(action, button);
      } else expect(button).toBeNull();
    }
    expect(lifecycle.load).toHaveBeenCalledOnce();
    expect(lifecycle.run).not.toHaveBeenCalled();
  },
);

it("removes previously allowed actions when the replacement permission read fails", async () => {
  const lifecycle = capability();
  lifecycle.load.mockResolvedValueOnce({
    ...settings,
    canArchive: true,
    canDelete: true,
  });
  const mounted = render(
    <ChannelLifecycleActions
      channelId={settings.channelId}
      lifecycle={lifecycle}
      choose={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Delete channel" });
  const replacement = capability();
  replacement.load.mockRejectedValueOnce(new Error("Permissions unavailable"));
  mounted.rerender(
    <ChannelLifecycleActions
      channelId={settings.channelId}
      lifecycle={replacement}
      choose={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  await screen.findByRole("alert");
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Retry channel permissions" }),
  ).toBeEnabled();
  replacement.load.mockResolvedValueOnce({
    ...settings,
    canLeave: false,
    canArchive: true,
    canDelete: false,
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry channel permissions" }));
  await screen.findByRole("button", { name: "Archive channel" });
  expect(screen.queryByRole("button", { name: "Delete channel" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Leave channel" })).toBeNull();
});

it.each([true, false])(
  "Delete outage preserves available Archive=%s and Leave, then retries",
  async (canArchive) => {
    const lifecycle = capability();
    const choose = vi.fn();
    lifecycle.load.mockResolvedValueOnce({
      ...settings,
      canArchive,
      deleteUnavailable: true,
    });
    render(
      <ChannelLifecycleActions
        channelId={settings.channelId}
        lifecycle={lifecycle}
        choose={choose}
      />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Delete check unavailable",
    );
    expect(screen.getByRole("button", { name: "Leave channel" })).toBeEnabled();
    expect(!!screen.queryByRole("button", { name: "Archive channel" })).toBe(
      canArchive,
    );
    expect(screen.queryByRole("button", { name: "Delete channel" })).toBeNull();
    lifecycle.load.mockResolvedValue({
      ...settings,
      canArchive,
      canDelete: true,
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry Delete check" }));
    expect(
      await screen.findByRole("button", { name: "Delete channel" }),
    ).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  },
);

const unavailable = { ...settings, canArchive: true, deleteUnavailable: true };
it.each([
  {
    name: "Delete allowed",
    value: { ...settings, canDelete: true },
    target: "Delete channel",
  },
  {
    name: "repeated profile failure",
    value: unavailable,
    target: "Retry Delete check",
  },
  { name: "Delete forbidden", value: settings, target: "Leave channel" },
  {
    name: "Archive only",
    value: { ...settings, canLeave: false, canArchive: true },
    target: "Archive channel",
  },
  {
    name: "no actions",
    value: { ...settings, canLeave: false },
    target: undefined,
  },
  {
    name: "permissions failure",
    value: undefined,
    target: "Retry channel permissions",
  },
])(
  "keeps keyboard focus through held retry: $name",
  async ({ value, target }) => {
    const lifecycle = capability();
    lifecycle.load.mockResolvedValueOnce(unavailable);
    const choose = vi.fn();
    render(
      <ChannelLifecycleActions
        channelId={settings.channelId}
        lifecycle={lifecycle}
        choose={choose}
      />,
    );
    const retry = await screen.findByRole("button", {
      name: "Retry Delete check",
    });
    const gate = deferred<ChannelLifecycleSettings>();
    lifecycle.load.mockImplementationOnce(async () => {
      const result = await gate.promise;
      if (!value) throw new Error("Permissions unavailable");
      return result;
    });
    const user = userEvent.setup();
    retry.focus();
    await user.keyboard("{Enter}");
    try {
      await waitFor(() => expect(lifecycle.load).toHaveBeenCalledTimes(2));
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(screen.getAllByRole("button")).toEqual([retry]);
      await user.keyboard("{Enter}");
      expect(lifecycle.load).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => gate.resolve(value ?? settings));
    }
    const result = target
      ? screen.getByRole("button", { name: target })
      : screen.getByRole("status");
    expect(result).toHaveFocus();
    if (!target)
      expect(result).toHaveTextContent("No channel actions available.");
    expect(choose).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  },
);
it("does not steal focus when the user leaves a pending retry", async () => {
  const lifecycle = capability();
  lifecycle.load.mockResolvedValueOnce(unavailable);
  render(
    <>
      <ChannelLifecycleActions
        channelId={settings.channelId}
        lifecycle={lifecycle}
        choose={vi.fn()}
      />
      <button type="button">Other setting</button>
    </>,
  );
  const retry = await screen.findByRole("button", {
    name: "Retry Delete check",
  });
  const gate = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(gate.promise);
  const user = userEvent.setup();
  retry.focus();
  await user.keyboard("{Enter}");
  try {
    await waitFor(() => expect(lifecycle.load).toHaveBeenCalledTimes(2));
    await user.tab();
    expect(screen.getByRole("button", { name: "Other setting" })).toHaveFocus();
  } finally {
    await act(async () => gate.resolve({ ...settings, canDelete: true }));
  }
  expect(screen.getByRole("button", { name: "Other setting" })).toHaveFocus();
});
