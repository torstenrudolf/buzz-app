// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import { writeView } from "../../shared/view-state";
import { ChannelCanvasDialog } from "./ChannelCanvasDialog";

const scope = "canvas-test";
const channelId = "11111111-1111-4111-8111-111111111111";
const key = keypair();
const head = signed(key, {
  kind: 40100,
  content: "Saved",
  tags: [["h", channelId]],
});
function fixture() {
  const canvas = {
    available: true,
    read: vi.fn(async () => head),
    save: vi.fn(async () => head),
  };
  const close = vi.fn();
  render(
    <ChannelCanvasDialog
      canvas={canvas}
      scope={scope}
      channelId={channelId}
      open
      onOpenChange={close}
    />,
  );
  return { canvas, close };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows only Save normally and preserves the read revision on an edited save", async () => {
  const user = userEvent.setup();
  const { canvas, close } = fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByText("Current saved document")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /Load current|Reload saved Canvas|Retry loading/,
    }),
  ).not.toBeInTheDocument();
  fireEvent.change(text, { target: { value: "Edited" } });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(canvas.save).toHaveBeenCalledWith(channelId, "Edited", head.id);
});

it("keeps a restored conflict draft until explicit confirmed reload", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: "My unsaved work",
    base: "a".repeat(64),
  });
  const { canvas } = fixture();
  expect(await screen.findByRole("alert")).toHaveTextContent("Canvas changed");
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  expect(text).toHaveValue("My unsaved work");
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Reload saved Canvas" }));
  expect(text).toHaveValue("My unsaved work");
  expect(canvas.read).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Reload saved Canvas" }));
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reload saved Canvas" }),
  ).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
});

it("retries a failed initial read without discarding the restored draft", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: "Unsaved",
    base: head.id,
  });
  const canvas = {
    available: true,
    read: vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(head),
    save: vi.fn(async () => head),
  };
  render(
    <ChannelCanvasDialog
      canvas={canvas}
      scope={scope}
      channelId={channelId}
      open
      onOpenChange={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  await user.click(screen.getByRole("button", { name: "Retry loading" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toHaveValue(
    "Unsaved",
  );
  expect(canvas.save).not.toHaveBeenCalled();
});

it("ignores the stale StrictMode read after the current read enables typing and saving", async () => {
  const user = userEvent.setup();
  let release!: (value: typeof head) => void;
  const stale = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  const canvas = {
    available: true,
    read: vi.fn().mockReturnValueOnce(stale).mockResolvedValue(head),
    save: vi.fn(async () => ({ ...head, id: "b".repeat(64) })),
  };
  const close = vi.fn();
  render(
    <StrictMode>
      <ChannelCanvasDialog
        canvas={canvas}
        scope={scope}
        channelId={channelId}
        open
        onOpenChange={close}
      />
    </StrictMode>,
  );
  try {
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toHaveValue("Saved"));
    expect(canvas.read).toHaveBeenCalledTimes(2);
    fireEvent.change(text, { target: { value: "New work" } });
    await act(async () => {
      release({ ...head, content: "Stale response" });
      await stale;
    });
    expect(text).toHaveValue("New work");
    await user.click(screen.getByRole("button", { name: "Save Canvas" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(canvas.save).toHaveBeenCalledWith(channelId, "New work", head.id);
  } finally {
    release(head);
  }
});

it("returns focus to the ingress on close and retains edits without publishing", async () => {
  const user = userEvent.setup();
  const canvas = {
    available: true,
    read: vi.fn(async () => head),
    save: vi.fn(async () => head),
  };
  function Harness() {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button type="button" ref={trigger} onClick={() => setOpen(true)}>
          Canvas
        </button>
        {open && (
          <ChannelCanvasDialog
            canvas={canvas}
            scope={scope}
            channelId={channelId}
            open={open}
            onOpenChange={setOpen}
            finalFocus={trigger}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Canvas" });
  await user.click(trigger);
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  await user.clear(text);
  await user.type(text, "Local draft");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toHaveValue(
    "Local draft",
  );
  await user.click(screen.getByRole("button", { name: "Close Canvas" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
});
