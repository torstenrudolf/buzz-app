// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { npubEncode } from "nostr-tools/nip19";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { PresenceStatus } from "../../features/presence/presence";
import type { AgentView } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentCard } from "./AgentCard";

afterEach(cleanup);

it("badges a single agent only while live presence is known", () => {
  const pubkey = "a".repeat(64);
  let status: PresenceStatus = "unknown";
  let changed = () => {};
  const session = {
    presence: {
      status: () => status,
      limited: () => false,
      subscribe: (_key: string, listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  } as unknown as RelaySession;
  render(
    <AgentCard
      name="Agent"
      avatar="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5qV8AAAAASUVORK5CYII="
      identities={[{ pubkey, name: "Agent" }]}
      session={session}
    />,
  );
  const artwork = screen.getByRole("img", { name: "Agent" });
  expect(artwork.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  const image = artwork.querySelector("img");
  expect(image).toBeTruthy();
  fireEvent.load(image as HTMLImageElement);
  expect(image).toHaveAttribute("data-loaded", "true");
  expect(artwork.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
    "data-status",
  );
  for (const next of ["online", "away", "offline", "unknown"] as const) {
    act(() => {
      status = next;
      changed();
    });
    const updated = screen.getByRole("img", {
      name:
        next === "unknown"
          ? "Agent"
          : `Agent, ${next === "online" ? "available" : next}`,
    });
    const badge = updated.querySelector(".buzz-avatar-status");
    expect(updated).toBe(artwork);
    expect(updated.querySelector("img")).toBe(image);
    expect(image).toHaveAttribute("data-loaded", "true");
    if (next === "unknown") {
      expect(badge).not.toHaveAttribute("data-status");
      expect(badge?.querySelector(".buzz-avatar-status-dot")).toBeNull();
    } else if (next === "online") {
      expect(updated.querySelector(".badge-pill-ink")).toHaveStyle({
        visibility: "visible",
      });
    } else {
      expect(badge).toHaveAttribute("data-status", next);
    }
  }
});

it("re-reads presence after native start or stop until the badge agrees, within a bound", () => {
  vi.useFakeTimers();
  try {
    const agent = controlFixture().agent;
    let status: PresenceStatus = "offline";
    let changed = () => {};
    const refresh = vi.fn();
    const session = {
      presence: {
        status: () => status,
        limited: () => false,
        refresh,
        subscribe: (_key: string, listener: () => void) => {
          changed = listener;
          return () => {};
        },
      },
    } as unknown as RelaySession;
    const card = (next: AgentView) => (
      <AgentCard
        name="Agent"
        identities={[next]}
        editable={[next]}
        session={session}
        onEdit={() => {}}
      >
        <p>{next.status}</p>
      </AgentCard>
    );
    const view = render(card({ ...agent, status: "stopped" }));
    expect(refresh).not.toHaveBeenCalled();
    view.rerender(card({ ...agent, status: "running" }));
    expect(refresh).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(30000));
    expect(refresh).toHaveBeenCalledTimes(7);
    act(() => vi.advanceTimersByTime(60000));
    expect(refresh).toHaveBeenCalledTimes(7);

    view.rerender(card({ ...agent, status: "stopped" }));
    view.rerender(card({ ...agent, status: "running" }));
    expect(refresh).toHaveBeenCalledTimes(8);
    act(() => {
      status = "online";
      changed();
    });
    act(() => vi.advanceTimersByTime(30000));
    expect(refresh).toHaveBeenCalledTimes(8);

    view.rerender(card({ ...agent, status: "stopped" }));
    expect(refresh).toHaveBeenCalledTimes(9);
    act(() => {
      status = "offline";
      changed();
    });
    act(() => vi.advanceTimersByTime(30000));
    expect(refresh).toHaveBeenCalledTimes(9);
  } finally {
    vi.useRealTimers();
  }
});

it("opens identities in a popover and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const pubkey = "ab".repeat(32);
  render(<AgentCard name="Agent" identities={[{ pubkey, name: "Agent" }]} />);
  const trigger = screen.getByRole("button", { name: "Agent: public key" });
  expect(screen.queryByText(npubEncode(pubkey))).toBeNull();
  const card = screen.getByRole("article");
  await user.click(trigger);
  const popup = await screen.findByRole("dialog", {
    name: "Agent public key",
  });
  expect(card).not.toContainElement(popup);
  expect(screen.getByText(npubEncode(pubkey))).toBeVisible();
  expect(document.body.textContent).not.toContain(pubkey);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});
