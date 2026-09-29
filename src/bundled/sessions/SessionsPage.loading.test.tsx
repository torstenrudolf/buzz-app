// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { ChannelList } from "../../features/relay/contracts";
import { SessionsPage } from "./SessionsPage";

afterEach(cleanup);
it.each([false, true])(
  "shows initial session loading only without retained sessions (retained=%s)",
  (retained) => {
    const owner = createRelaySession(null);
    const list: ChannelList = {
      status: "loading",
      channels: retained
        ? [{ id: "session", name: "Planning", channelType: "session" }]
        : [],
    };
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        list: () => list,
        ensureList() {},
      },
    };
    const snapshot = {
      status: "ready" as const,
      generation: 1,
      scope: "loading-test",
      session,
    };
    const relay: RelayData = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      async clearCache() {},
    };
    const empty = { snapshot: () => [], subscribe: () => () => {} };
    try {
      render(
        <SessionsPage
          relay={relay}
          extensions={{ tools: empty, inline: empty }}
        />,
      );
      if (retained) {
        expect(screen.getByRole("button", { name: /Planning/ })).toBeVisible();
        expect(screen.queryByText("Loading sessions…")).toBeNull();
      } else expect(screen.getByText("Loading sessions…")).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);
