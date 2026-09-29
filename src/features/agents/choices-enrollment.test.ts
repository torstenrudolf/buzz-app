import { expect, it } from "vitest";
import { sameCommunityAgents } from "./choices";
import { controlFixture } from "./control-testing";
it("excludes imported-but-unconfigured identities from mention enrollment", () => {
  const { agent } = controlFixture();
  const scope = `https://relay.example.test:${"de".repeat(32)}`;
  expect(
    sameCommunityAgents(
      [
        agent,
        { ...agent, id: "retained", configured: false },
        { ...agent, id: "other", relayUrl: "wss://other.example" },
      ],
      scope,
    ),
  ).toEqual([agent]);
});
