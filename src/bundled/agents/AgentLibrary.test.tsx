// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { createRelaySession } from "../../features/relay/session";
import { bindNames } from "../../features/identity-names/service";
import { agentDirectory } from "../../features/identity-names/testing";
import { AgentLibrary } from "./AgentLibrary";
afterEach(cleanup);
it("renders linked identities as separate named tiles while retaining profile-only entries", async () => {
  const keys = ["a".repeat(64), "b".repeat(64)];
  const owned = createRelaySession({
    viewer: "c".repeat(64),
    relayAuthor: "d".repeat(64),
    scope: "wss://here.test",
    query: async () => [],
    media: () => undefined,
    readAgentLibrary: async () => ({
      definitions: [
        { id: "linked", name: "Larry" },
        { id: "empty", name: "Empty" },
      ],
      identities: keys.map((pubkey) => ({
        pubkey,
        name: "Larry",
        definitionId: "linked",
      })),
    }),
  });
  const names = bindNames(owned.session, {
    snapshot: () => [agentDirectory],
    subscribe: () => () => {},
  });
  const mounted = render(
    <AgentLibrary session={{ ...owned.session, names }} headerActions={null} />,
  );
  try {
    for (const key of keys) {
      const label = `Larry · ${npubEncode(key).slice(-4)}`;
      const card = await screen.findByRole("article", {
        name: `Agent ${label}`,
      });
      fireEvent.click(
        within(card).getByRole("button", { name: `${label}: public key` }),
      );
      const popup = await screen.findByRole("dialog", {
        name: `${label} public key`,
      });
      expect(within(popup).getByText(npubEncode(key))).toBeTruthy();
      fireEvent.keyDown(popup, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(
      within(
        screen.getByRole("region", { name: "Profiles without identities" }),
      ).getByText("Empty"),
    ).toBeTruthy();
  } finally {
    mounted.unmount();
    names.dispose();
    owned.dispose();
  }
});
