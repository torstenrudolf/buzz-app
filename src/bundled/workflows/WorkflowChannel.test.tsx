// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureDefinition,
  fixtureViewer,
} from "./fixtures";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

it("hands confirmed deletion to the page and discards draft navigation risk", async () => {
  const fixture = createWorkflowFixture();
  const remove = vi.fn();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channelName="Fixture channel"
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onDelete={remove}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  await user.type(
    screen.getByRole("textbox", { name: "Workflow YAML" }),
    "\n# Unsaved edit",
  );
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith(fixtureDefinition);
  expect(screen.queryByRole("dialog", { name: "Edit workflow" })).toBeNull();
  expect(
    screen.queryByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeNull();
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(true);
  expect(fixture.calls.delete).toBe(0);
});

it("keeps loaded configurations visible without a refresh banner", async () => {
  const fixture = createWorkflowFixture();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channelName="Fixture channel"
      viewer={fixtureViewer}
      onDelete={() => {}}
    />,
  );
  await screen.findByText("Message helper");
  act(() =>
    fixture.definitions.update({
      status: "loading",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(screen.getByText("Message helper")).toBeVisible();
  expect(screen.queryByText("Reading configurations…")).toBeNull();
  act(() =>
    fixture.definitions.update({
      status: "error",
      error: "Read failed",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  expect(
    screen.getByRole("button", { name: "Refresh configurations" }),
  ).toBeEnabled();
});
