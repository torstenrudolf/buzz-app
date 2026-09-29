// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Dialog } from "@base-ui/react/dialog";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentImport } from "./AgentImport";
afterEach(cleanup);
it.each([false, true])(
  "reviews only the selected key and excludes saved keys across destinations: saved=%s",
  async (saved) => {
    const f = controlFixture();
    const key = "cd".repeat(32);
    const control = createAgentControl(f.host);
    const imported = vi.fn();
    const mounted = render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Popup>
            <AgentImport
              control={control}
              disabled={false}
              initialDestination="https://relay.example.test"
              initialSource="development"
              selectedPubkey={key}
              selectedName="Selected"
              managedAgents={
                saved
                  ? [
                      {
                        ...f.agent,
                        pubkey: key,
                        relayUrl: "wss://elsewhere.test",
                      },
                    ]
                  : []
              }
              onImported={imported}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    try {
      expect(
        await screen.findByRole("heading", { name: "Import Selected?" }),
      ).toBeVisible();
      const submit = screen.getByRole("button", { name: "Import agent" });
      if (saved) {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "already imported",
        );
        expect(submit).toBeDisabled();
        expect(f.calls.some((call) => call.action === "import")).toBe(false);
      } else {
        await waitFor(() => expect(submit).toBeEnabled());
        fireEvent.click(submit);
        await waitFor(() => expect(imported).toHaveBeenCalledOnce());
        expect(imported.mock.calls[0]?.[0]).toEqual([
          expect.objectContaining({ pubkey: key, enabled: false }),
        ]);
      }
    } finally {
      mounted.unmount();
      control.dispose();
    }
  },
);
