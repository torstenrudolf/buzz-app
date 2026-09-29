// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";

afterEach(cleanup);

it("shows known channel details with diagnostics collapsed until requested", async () => {
  const user = userEvent.setup();
  render(
    <ChannelSettingsPanel
      channel={{
        id: "alpha",
        name: "Alpha",
        channelType: "stream",
        members: ["one", "two"],
      }}
      close={() => {}}
    >
      <button type="button">Refresh messages</button>
    </ChannelSettingsPanel>,
  );
  expect(
    screen.getByRole("complementary", { name: "Channel settings" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Alpha" })).toBeVisible();
  expect(screen.getByText("alpha")).toBeVisible();
  expect(screen.getByText("2")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Close channel settings" }),
  ).toHaveFocus();
  expect(screen.getByText("Refresh messages")).not.toBeVisible();
  await user.click(screen.getByText("Diagnostics"));
  expect(
    screen.getByRole("button", { name: "Refresh messages" }),
  ).toBeVisible();
});

it("closes with Escape or its close button without swallowing other keys", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelSettingsPanel channel={undefined} close={close}>
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  await user.keyboard("{ArrowDown}");
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Close channel settings" }),
  );
  expect(close).toHaveBeenCalledTimes(2);
});

it("does not invent unknown metadata and still exposes diagnostics without a channel", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ChannelSettingsPanel
      channel={{ id: "dm", name: "Someone", channelType: "dm" }}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText("Direct message")).toBeVisible();
  expect(screen.queryByText("Members")).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel channel={undefined} close={() => {}}>
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.queryByText("Channel ID")).not.toBeInTheDocument();
  await user.click(screen.getByText("Diagnostics"));
  expect(screen.getByText("Diagnostics content")).toBeVisible();
});

it("opens Canvas from its own keyboard-accessible row before setup actions", async () => {
  const user = userEvent.setup();
  const openCanvas = vi.fn();
  render(
    <ChannelSettingsPanel
      channel={{ id: "alpha", name: "Alpha", channelType: "stream" }}
      close={() => {}}
      openCanvas={openCanvas}
      setupTools={<button type="button">Leave channel</button>}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  const canvas = screen.getByRole("button", { name: "Canvas" });
  expect(canvas).toHaveAttribute("aria-haspopup", "dialog");
  expect(canvas).not.toHaveTextContent("Shared notes and plans");
  expect(openCanvas).not.toHaveBeenCalled();
  await user.tab();
  expect(canvas).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(openCanvas).toHaveBeenCalledTimes(1);
  expect(openCanvas).toHaveBeenLastCalledWith(canvas);
  await user.tab();
  expect(screen.getByRole("button", { name: "Leave channel" })).toHaveFocus();
  await user.click(canvas);
  expect(openCanvas).toHaveBeenCalledTimes(2);
});

it("omits Canvas without a writable channel or an opener", () => {
  const channel = { id: "alpha", name: "Alpha" };
  const { rerender } = render(
    <ChannelSettingsPanel channel={channel} close={() => {}}>
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(
    screen.queryByRole("button", { name: "Canvas" }),
  ).not.toBeInTheDocument();
  for (const unavailable of [
    undefined,
    { ...channel, readOnly: true as const },
  ]) {
    rerender(
      <ChannelSettingsPanel
        channel={unavailable}
        close={() => {}}
        openCanvas={() => {}}
      >
        Diagnostics content
      </ChannelSettingsPanel>,
    );
    expect(
      screen.queryByRole("button", { name: "Canvas" }),
    ).not.toBeInTheDocument();
  }
});

const head = signed(keypair(), {
  kind: 40100,
  content: "# Google root-link preview submission deep dive",
  tags: [["h", "alpha"]],
});
function previewFixture() {
  return {
    available: true,
    read: vi.fn<ChannelCanvas["read"]>().mockResolvedValue(head),
    save: vi.fn<ChannelCanvas["save"]>(),
  };
}
function panel(
  canvas: ChannelCanvas,
  id = "alpha",
  canvasOpen = false,
  readOnly?: true,
) {
  return (
    <ChannelSettingsPanel
      canvas={canvas}
      channel={{ id, name: id, ...(readOnly ? { readOnly } : {}) }}
      canvasOpen={canvasOpen}
      openCanvas={() => {}}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>
  );
}

it("shows Canvas as the first line and saved plain text as the secondary preview", async () => {
  const canvas = previewFixture();
  const { container } = render(panel(canvas));
  expect(screen.getByText("Loading preview…")).toBeVisible();
  await screen.findByText("Google root-link preview submission deep dive");
  const row = screen.getByRole("button", { name: "Canvas" });
  expect(row).toHaveAccessibleDescription(
    "Google root-link preview submission deep dive",
  );
  expect(row.querySelector(".buzz-choice-row-label")).toHaveTextContent(
    /^Canvas$/,
  );
  expect(row.querySelector(".buzz-choice-row-description")).toHaveTextContent(
    "Google root-link preview submission deep dive",
  );
  expect(canvas.read).toHaveBeenCalledWith("alpha");
  expect(canvas.save).not.toHaveBeenCalled();
  expect(container.querySelector("img, script")).toBeNull();
});

it.each([
  undefined,
  { ...head, content: "   \n" },
  { ...head, content: "<!-- comment -->" },
])("uses neutral empty copy for %j", async (event) => {
  const canvas = previewFixture();
  canvas.read.mockResolvedValue(event);
  render(panel(canvas));
  expect(await screen.findByText("No content yet")).toBeVisible();
  expect(screen.getByRole("button", { name: "Canvas" })).toBeEnabled();
});

it("keeps a failed preview openable and refreshes saved content after closing the editor", async () => {
  const canvas = previewFixture();
  canvas.read.mockRejectedValueOnce(new Error("Offline"));
  const { rerender } = render(panel(canvas));
  expect(
    await screen.findByText("Preview unavailable. Open to retry."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Canvas" })).toBeEnabled();
  rerender(panel(canvas, "alpha", true));
  expect(canvas.read).toHaveBeenCalledTimes(1);
  rerender(panel(canvas));
  expect(
    await screen.findByText("Google root-link preview submission deep dive"),
  ).toBeVisible();
  rerender(panel(canvas, "alpha", true));
  canvas.read.mockResolvedValue({ ...head, content: "# Updated document" });
  rerender(panel(canvas));
  expect(await screen.findByText("Updated document")).toBeVisible();
  expect(canvas.save).not.toHaveBeenCalled();
});

it("ignores an old channel's pending preview and hides content immediately on scope or access changes", async () => {
  const canvas = previewFixture();
  let release!: (event: typeof head) => void;
  canvas.read.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const { rerender } = render(panel(canvas));
  try {
    canvas.read.mockResolvedValue({ ...head, content: "# Beta document" });
    rerender(panel(canvas, "beta"));
    expect(await screen.findByText("Beta document")).toBeVisible();
  } finally {
    await act(async () => release(head));
  }
  expect(
    screen.queryByText("Google root-link preview submission deep dive"),
  ).not.toBeInTheDocument();
  const otherCommunity = previewFixture();
  otherCommunity.read.mockResolvedValue(undefined);
  rerender(panel(otherCommunity, "beta"));
  expect(screen.queryByText("Beta document")).not.toBeInTheDocument();
  expect(await screen.findByText("No content yet")).toBeVisible();
  rerender(panel(otherCommunity, "beta", false, true));
  expect(
    screen.queryByRole("button", { name: /^Canvas/ }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(otherCommunity.read).toHaveBeenCalledTimes(1));
});
