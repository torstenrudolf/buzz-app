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
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateSettings } from "./UpdateSettings";
import { createUpdates, type UpdatePlatform, type Updates } from "./updates";

const native = vi.hoisted(() => ({
  getVersion: vi.fn(async () => "1.2.3"),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: native.getVersion }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));

let updates: Updates | undefined;
afterEach(() => {
  cleanup();
  updates?.dispose();
});

/** Reactions run in registration order, so the owner finishes its check first. */
async function afterBackgroundCheck(check: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  await Promise.resolve(check.mock.results[0]?.value).catch(() => {});
}

function renderSettings(platform: Partial<UpdatePlatform>) {
  updates = createUpdates({
    desktop: true,
    check: async () => null,
    relaunch: async () => {},
    ...platform,
  });
  render(<UpdateSettings updates={updates} active />);
  return updates;
}

it("checks on request and checks again from the latest version", async () => {
  const check = vi.fn(async () => null);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  expect(
    screen.getByRole("heading", { name: "Software Updates" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Keep Buzz up to date with the latest features and fixes.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText("Check if a new version is available."),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
  expect(check).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Check Again" }));
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
});

it("shows progress, then applies a downloaded update", async () => {
  let finishDownload!: () => void;
  const relaunch = vi.fn(async () => {});
  const update = {
    version: "1.2.3",
    download: () =>
      new Promise<void>((resolve) => {
        finishDownload = resolve;
      }),
    install: async () => {},
    close: async () => {},
  };
  renderSettings({ check: async () => update, relaunch });
  expect(await screen.findByText("Downloading update...")).toBeVisible();
  finishDownload();
  expect(
    await screen.findByText("Update downloaded. Click to apply."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Update Now" }));
  await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});

it("reports failures and retries", async () => {
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValue(null);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(await screen.findByText("Update failed: network down")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
});

it("explains builds without automatic updates", async () => {
  renderSettings({ desktop: false });
  fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(
    await screen.findByText(
      "Automatic updates aren't available on this build. Download the latest release manually.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Check Again" })).toBeVisible();
});

it("shows the installed version in the header", async () => {
  native.isTauri.mockReturnValue(true);
  try {
    renderSettings({});
    const subtitle = await screen.findByText(
      "Keep Buzz up to date with the latest features and fixes.",
    );
    // The subtitle renders the version on its own line above the tagline.
    const lineBreaks = subtitle.querySelectorAll("br");
    const text = subtitle.textContent ?? "";
    expect(lineBreaks).toHaveLength(1);
    expect(text.startsWith("Version 1.2.3")).toBe(true);
    expect(
      text.endsWith("Keep Buzz up to date with the latest features and fixes."),
    ).toBe(true);
    expect(native.getVersion).toHaveBeenCalledOnce();
  } finally {
    native.isTauri.mockReturnValue(false);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("preserves the focused action and status through held check, failure, retry and result", async () => {
  const user = userEvent.setup();
  const first = deferred<null>();
  const retry = deferred<null>();
  const again = deferred<null>();
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise)
    .mockReturnValueOnce(again.promise);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  const action = screen.getByRole("button", { name: "Check for Updates" });
  const status = screen.getByRole("status");
  await user.tab();
  expect(action).toHaveFocus();
  try {
    await user.keyboard("{Enter}");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Checking for updates...");
    await user.keyboard("{Enter}");
    expect(check).toHaveBeenCalledTimes(2);
    await act(async () => first.reject(new Error("offline")));
    expect(screen.getByRole("button", { name: "Retry" })).toBe(action);
    expect(action).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(3));
    expect(action).toHaveFocus();
    await act(async () => retry.resolve(null));
    expect(screen.getByRole("button", { name: "Check Again" })).toBe(action);
    expect(action).toHaveFocus();
    expect(screen.getByRole("status")).toBe(status);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(4));
    await user.tab();
    expect(action).not.toHaveFocus();
    await act(async () => again.resolve(null));
    expect(action).not.toHaveFocus();
  } finally {
    await act(async () => {
      first.resolve(null);
      retry.resolve(null);
      again.resolve(null);
    });
  }
});

it("keeps focus through download, install and refused restart", async () => {
  const user = userEvent.setup();
  const download = deferred<void>();
  const install = deferred<void>();
  const update = {
    version: "1.2.3",
    download: () => download.promise,
    install: () => install.promise,
    close: async () => {},
  };
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(update);
  renderSettings({
    check,
    relaunch: async () => {
      throw new Error("shutdown refused");
    },
  });
  await afterBackgroundCheck(check);
  const action = screen.getByRole("button", { name: "Check for Updates" });
  await user.tab();
  try {
    await user.keyboard("{Enter}");
    await screen.findByText("Downloading update...");
    expect(action).toHaveFocus();
    await act(async () => download.resolve());
    expect(screen.getByRole("button", { name: "Update Now" })).toBe(action);
    await user.keyboard("{Enter}");
    expect(screen.getByText("Installing update...")).toBeVisible();
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute("aria-busy", "true");
    await act(async () => install.resolve());
    expect(screen.getByText("Update failed: shutdown refused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(action);
    expect(action).toHaveFocus();
  } finally {
    await act(async () => {
      download.resolve();
      install.resolve();
    });
  }
});
