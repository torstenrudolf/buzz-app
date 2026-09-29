// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelDetailsEditor } from "./ChannelDetailsEditor";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import type {
  ChannelDetailsCapability,
  DetailsAttempt,
} from "../../features/relay/channel-details";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";

afterEach(cleanup);
const channel = {
  id: "alpha",
  name: "Alpha",
  description: "Existing description",
  visibility: "public" as const,
  channelType: "stream" as const,
};
const base: ChannelDetails = {
  channelId: channel.id,
  version: "v1",
  name: channel.name,
  description: channel.description,
  visibility: "public",
  canEdit: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  let attempt: DetailsAttempt | undefined;
  const listeners = new Set<() => void>();
  const load = vi.fn(async () => base);
  const save = vi.fn(async () => {});
  const check = vi.fn(async () => {});
  const capability: ChannelDetailsCapability = {
    available: true,
    load,
    save,
    check,
    snapshot: () => attempt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const setAttempt = (next: DetailsAttempt | undefined) => {
    attempt = next;
    for (const listener of listeners) listener();
  };
  return { capability, load, save, check, setAttempt };
}
it("edits deliberately, cancels every field, and sends all fields only on Save", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed");
  await user.clear(screen.getByRole("textbox", { name: "Description" }));
  await user.click(screen.getByRole("combobox", { name: "Visibility" }));
  await user.click(await screen.findByRole("option", { name: "Private" }));
  expect(
    screen.getByText(/Saving makes this channel invite-only/),
  ).toBeVisible();
  expect(h.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    channel.description,
  );
  expect(
    screen.getByRole("combobox", { name: "Visibility" }),
  ).toHaveTextContent("Public");
  await user.clear(screen.getByRole("textbox", { name: "Description" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, description: "" },
    expect.any(AbortSignal),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus(),
  );
});
it("retains rejected edits and preserves them through an explicit authority reload", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Permission changed"));
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    " draft",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Permission changed",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    `${channel.description} draft`,
  );
  h.load.mockResolvedValueOnce({ ...base, canEdit: false });
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    `${channel.description} draft`,
  );
});
it("reloads authoritative privacy after a conflict and saves retained text edits", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Channel details changed"));
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "My renamed channel" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
    target: { value: "My retained description" },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Channel details changed",
  );
  const privateBase = {
    ...base,
    version: "v2",
    visibility: "private" as const,
  };
  h.load.mockResolvedValue(privateBase);
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  expect(
    await screen.findByText(
      "Private · This channel cannot be made public here.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "My renamed channel",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "My retained description",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenLastCalledWith(
    privateBase,
    {
      ...base,
      name: "My renamed channel",
      description: "My retained description",
      visibility: "private",
    },
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("unknown outcomes survive remount and checking never invokes Save", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.setAttempt({
    draft: { ...base, name: "Pending name" },
    status: "unconfirmed",
  });
  const first = render(
    <ChannelDetailsEditor capability={h.capability} channel={channel} />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Review pending changes" }),
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Review pending changes" }),
  ).toHaveFocus();
  first.unmount();
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(
    await screen.findByRole("button", { name: "Review pending changes" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Check save status" }),
    ).toBeEnabled(),
  );
  h.check.mockRejectedValueOnce(new Error("Not yet confirmed"));
  await user.click(screen.getByRole("button", { name: "Check save status" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not yet confirmed",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Pending name",
  );
  expect(h.save).not.toHaveBeenCalled();
});
it.each(["channel", "session"])(
  "drops drafts and late reads when the %s changes",
  async (change) => {
    const h = harness(),
      next = harness();
    const user = userEvent.setup();
    const { rerender } = render(
      <ChannelDetailsEditor capability={h.capability} channel={channel} />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      " private draft",
    );
    const gate = deferred<ChannelDetails>();
    next.load.mockImplementationOnce(() => gate.promise);
    const changedChannel =
      change === "channel" ? { ...channel, id: "beta", name: "Beta" } : channel;
    rerender(
      <ChannelDetailsEditor
        capability={next.capability}
        channel={changedChannel}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    rerender(
      <ChannelDetailsEditor capability={h.capability} channel={channel} />,
    );
    await act(async () => {
      gate.resolve({ ...base, name: "Wrong late name" });
    });
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alpha");
  },
);
it("keeps details readable without editing authority or host support", async () => {
  const h = harness();
  h.load.mockResolvedValueOnce({ ...base, canEdit: false });
  const { rerender } = render(
    <ChannelSettingsPanel
      channel={channel}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText(channel.description)).toBeVisible();
  expect(screen.getByText("Public")).toBeVisible();
  await screen.findByText(/Only current channel owners/);
  expect(
    screen.queryByRole("button", { name: "Edit details" }),
  ).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel
      channel={{ ...channel, readOnly: true }}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText(channel.description)).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Edit channel details" }),
  ).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel channel={channel} close={() => {}}>
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(
    screen.getByText("Editing is unavailable on this connection."),
  ).toBeVisible();
});

it("orders metadata, Canvas, and actions and dismisses each edit layer with Escape", async () => {
  const h = harness();
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelSettingsPanel
      channel={channel}
      details={h.capability}
      openCanvas={() => {}}
      setupTools={<button type="button">Leave channel</button>}
      close={close}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  const edit = await screen.findByRole("button", { name: "Edit details" });
  const canvas = screen.getByRole("button", { name: "Canvas" });
  expect(
    screen.getByText(channel.description).compareDocumentPosition(canvas) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.tab();
  expect(canvas).toHaveFocus();
  await user.tab();
  expect(edit).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Leave channel" })).toHaveFocus();
  await user.click(edit);
  expect(
    screen.getByRole("dialog", { name: "Edit channel details" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus(),
  );
  await user.click(screen.getByRole("combobox", { name: "Visibility" }));
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Public" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
});
it("only enables Save for normalized, changed, valid fields with connected errors", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  const description = screen.getByRole("textbox", { name: "Description" });
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  fireEvent.change(name, { target: { value: " ## Alpha " } });
  expect(save).toBeDisabled();
  fireEvent.change(name, { target: { value: "### " } });
  expect(name).toHaveAccessibleDescription(/Enter a channel name/);
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(save).toBeDisabled();
  fireEvent.change(name, { target: { value: "😀".repeat(121) } });
  expect(name).toHaveValue("😀".repeat(120));
  fireEvent.change(name, { target: { value: "😀".repeat(120) } });
  expect(save).toBeEnabled();
  expect(name).toHaveAccessibleDescription("120 of 120 characters");
  fireEvent.change(description, { target: { value: "😀".repeat(1001) } });
  expect(description).toHaveValue("😀".repeat(1000));
  expect(description).toHaveAccessibleDescription("1,000 of 1,000 characters");
  expect(save).toBeEnabled();
  fireEvent.change(description, {
    target: { value: "Buzz session (reserved)" },
  });
  expect(save).toBeDisabled();
  expect(description).toHaveAccessibleDescription(
    'Remove "Buzz session (" from the description; that text is used by Buzz for work sessions.',
  );
  fireEvent.change(description, { target: { value: "😀".repeat(1000) } });
  expect(save).toBeEnabled();
  fireEvent.change(name, { target: { value: " ## Renamed " } });
  await user.click(save);
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, name: "Renamed", description: "😀".repeat(1000) },
    expect.any(AbortSignal),
  );
});
it.each(["save", "check"] as const)(
  "blocks every dismissal while %s is pending, then restores focus",
  async (operation) => {
    const h = harness();
    const user = userEvent.setup();
    const close = vi.fn();
    const gate = deferred<void>();
    const draft = { ...base, name: "Pending name" };
    if (operation === "check") h.setAttempt({ draft, status: "unconfirmed" });
    h[operation].mockImplementationOnce(async () => {
      if (operation === "save") h.setAttempt({ draft, status: "saving" });
      await gate.promise;
      h.setAttempt(undefined);
    });
    render(
      <ChannelSettingsPanel
        channel={channel}
        details={h.capability}
        close={close}
      >
        Diagnostics
      </ChannelSettingsPanel>,
    );
    await user.click(
      await screen.findByRole("button", {
        name: operation === "check" ? "Review pending changes" : "Edit details",
      }),
    );
    const action = await screen.findByRole("button", {
      name: operation === "check" ? "Check save status" : "Save changes",
    });
    await waitFor(() => expect(h.load).toHaveBeenCalledOnce());
    if (operation === "save")
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: draft.name },
      });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    try {
      expect(h[operation]).toHaveBeenCalledOnce();
      expect(action).toHaveAttribute("aria-busy", "true");
      expect(
        screen.getByRole("button", { name: "Close edit channel details" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Close" }));
      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await act(async () => gate.resolve());
    }
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus();
    expect(h[operation]).toHaveBeenCalledOnce();
    if (operation === "check") expect(h.save).not.toHaveBeenCalled();
  },
);
it("a save that becomes uncertain reopens in check-only recovery", async () => {
  const h = harness();
  const user = userEvent.setup();
  const draft = { ...base, name: "Pending name" };
  h.save.mockImplementationOnce(async () => {
    h.setAttempt({ draft, status: "unconfirmed" });
    throw new Error("The change may have been saved.");
  });
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: draft.name },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The change may have been saved.",
  );
  await user.click(
    screen.getByRole("button", { name: "Close edit channel details" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Review pending changes" }),
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(draft.name);
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Check save status" }),
  ).toBeEnabled();
  expect(h.save).toHaveBeenCalledOnce();
});
it("never offers public visibility for a private channel", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.load.mockResolvedValue({ ...base, visibility: "private" });
  render(
    <ChannelDetailsEditor
      capability={h.capability}
      channel={{ ...channel, visibility: "private" }}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    screen.getByText("Private · This channel cannot be made public here."),
  ).toBeVisible();
});

it.each([
  { field: "Name", threshold: 108, limit: 120, limitLabel: "120" },
  { field: "Description", threshold: 900, limit: 1000, limitLabel: "1,000" },
])(
  "reveals $field length feedback near the limit and caps typing and paste",
  async ({ field, threshold, limit, limitLabel }) => {
    const h = harness();
    const user = userEvent.setup();
    render(
      <ChannelDetailsEditor capability={h.capability} channel={channel} />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    const input = screen.getByRole("textbox", { name: field });
    expect(
      screen.getByRole("textbox", { name: "Name" }),
    ).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("textbox", { name: "Description" }),
    ).not.toHaveAccessibleDescription();
    fireEvent.change(input, { target: { value: "😀".repeat(threshold - 1) } });
    expect(input).not.toHaveAccessibleDescription();
    await user.type(input, "x");
    const counter = screen.getByText(`${threshold}/${limitLabel}`);
    expect(counter).toHaveAttribute("aria-hidden", "true");
    expect(counter.closest("label")).toHaveTextContent(field);
    expect(input).toHaveAccessibleName(field);
    expect(input).toHaveAccessibleDescription(
      `${threshold} of ${limitLabel} characters`,
    );
    await user.keyboard("{Backspace}");
    expect(
      screen.queryByText(`${threshold}/${limitLabel}`),
    ).not.toBeInTheDocument();
    expect(input).not.toHaveAccessibleDescription();
    await user.clear(input);
    await user.paste("😀".repeat(limit));
    expect(input).toHaveAccessibleDescription(
      `${limitLabel} of ${limitLabel} characters`,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await user.paste("x");
    expect(input).toHaveValue("😀".repeat(limit));
    await user.type(input, "x");
    expect(input).toHaveValue("😀".repeat(limit));
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      `${limitLabel} of ${limitLabel} characters`,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(
      screen.queryByText(`${limit + 1} of ${limitLabel} characters`),
    ).not.toBeInTheDocument();
    await user.clear(input);
    await user.paste("😀".repeat(limit + 20));
    expect(input).toHaveValue("😀".repeat(limit));
    // Inserting at capacity must not silently delete the existing tail.
    const control = input as HTMLInputElement | HTMLTextAreaElement;
    control.setSelectionRange(2, 2);
    await user.paste("overflow");
    expect(input).toHaveValue("😀".repeat(limit));
    control.setSelectionRange(2, 2);
    await user.paste("😀x");
    expect(input).toHaveValue("😀".repeat(limit));
    control.setSelectionRange(2, 6);
    await user.paste("abcdef");
    expect(input).toHaveValue(`😀ab${"😀".repeat(limit - 3)}`);
    expect(control.selectionStart).toBe(4);
    await user.clear(input);
    await user.paste("Short again");
    expect(input).not.toHaveAccessibleDescription();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  },
);

it.each([
  { field: "Name", key: "name", limit: 120 },
  { field: "Description", key: "description", limit: 1000 },
] as const)(
  "preserves existing over-limit $field text during reductions and replacements",
  async ({ field, key, limit }) => {
    const h = harness();
    const user = userEvent.setup();
    const original = `AB${"😀".repeat(limit + 1)}YZ`;
    h.load.mockResolvedValue({ ...base, [key]: original });
    render(
      <ChannelDetailsEditor capability={h.capability} channel={channel} />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    const input = screen.getByRole("textbox", { name: field }) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(input).toHaveValue(original);
    expect(save).toBeDisabled();
    await user.click(input);
    input.setSelectionRange(original.length, original.length);
    await user.keyboard("{Backspace}");
    const reduced = original.slice(0, -1);
    expect(input).toHaveValue(reduced);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    input.setSelectionRange(1, 1);
    await user.keyboard("{Delete}");
    const middleDeleted = `A${reduced.slice(2)}`;
    expect(input).toHaveValue(middleDeleted);
    input.setSelectionRange(1, 5);
    await user.paste("x");
    const replaced = `Ax${middleDeleted.slice(5)}`;
    expect(input).toHaveValue(replaced);
    expect(save).toBeDisabled();
    input.setSelectionRange(1, 1);
    await user.paste("no growth");
    expect(input).toHaveValue(replaced);
    input.setSelectionRange(1, 2);
    await user.paste("xyz");
    expect(input).toHaveValue(replaced);
    input.setSelectionRange(2, 6);
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue(`Ax${replaced.slice(6)}`);
    expect([...input.value]).toHaveLength(limit);
    expect(save).toBeEnabled();
    await user.paste("cannot grow now either");
    expect(input).toHaveValue(`Ax${replaced.slice(6)}`);
  },
);

it.each([
  ["\u0085# \u0085#Renamed\u0085", "Renamed"],
  ["\ufeffRenamed\ufeff", "\ufeffRenamed\ufeff"],
])("submits %j with the relay's canonical name", async (input, expected) => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: input },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, name: expected },
    expect.any(AbortSignal),
  );
});
