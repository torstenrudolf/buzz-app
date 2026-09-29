// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as api from "../../features/communities/api";
import { controlFixture } from "../../features/agents/control-testing";
import {
  createAgentControl,
  type CommunityResolution,
} from "../../features/agents/control";
import { LocalInventoryAction } from "./LocalInventoryAction";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("does not configure after the destination dialog is dismissed during resolution", async () => {
  let finish!: (r: CommunityResolution) => void;
  const pending = new Promise<CommunityResolution>((resolve) => {
    finish = resolve;
  });
  const request = vi.spyOn(api, "communityRequest").mockReturnValue(pending);
  const f = controlFixture();
  const control = createAgentControl(f.host);
  await control.refresh();
  const used = vi.fn();
  const mounted = render(
    <LocalInventoryAction
      control={control}
      agent={f.agent}
      destination="https://relay.example.test"
      owner={"de".repeat(32)}
      disabled={false}
      onPending={() => {}}
      onUsed={used}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use here" }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  mounted.unmount();
  await act(async () => {
    finish({
      pubkey: f.agent.pubkey,
      relayUrl: f.agent.relayUrl,
      owner: "de".repeat(32),
      signature: "signed",
    });
    await pending;
  });
  expect(f.calls.some((c) => c.action === "configure")).toBe(false);
  expect(used).not.toHaveBeenCalled();
  control.dispose();
});
