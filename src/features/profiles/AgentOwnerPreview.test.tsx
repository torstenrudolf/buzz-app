// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { createRelaySession } from "../relay/session";
import { keypair, profile, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import { AgentOwnerPreview } from "./AgentOwnerPreview";

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
});

it.each([true, false])(
  "shows only a verified owner, not a profile claim (valid: %s)",
  async (valid) => {
    const agent = keypair();
    const owner = keypair();
    const other = keypair();
    const digest = new Uint8Array(
      createHash("sha256").update(`nostr:agent-auth:${agent.pubkey}:`).digest(),
    );
    const events = [
      signed(agent, {
        kind: 0,
        content: JSON.stringify({ name: "Helper", owner: owner.pubkey }),
        tags: [
          [
            "auth",
            owner.pubkey,
            "",
            bytesToHex(
              schnorr.sign(digest, valid ? owner.secret : other.secret),
            ),
          ],
        ],
      }),
      profile(owner, { name: "Morgan" }),
    ];
    const host = createRelaySession({
      viewer: owner.pubkey,
      relayAuthor: keypair().pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    });
    stops.push(host.dispose);
    render(<AgentOwnerPreview session={host.session} pubkey={agent.pubkey} />);
    if (valid) {
      expect(await screen.findByText("Morgan (you)")).toBeVisible();
      expect(screen.getByText(npubEncode(owner.pubkey))).toBeVisible();
    } else {
      expect(await screen.findByText("Owner unavailable")).toBeVisible();
      expect(
        screen.queryByText(npubEncode(owner.pubkey)),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Morgan (you)")).not.toBeInTheDocument();
    }
  },
);
