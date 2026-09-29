// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkflowRuns } from "./WorkflowRuns";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureRun,
  fixtureView,
} from "./fixtures";

afterEach(cleanup);
it("keeps loaded runs visible without a refresh banner and retains failures", async () => {
  const fixture = createWorkflowFixture();
  const data = { runs: [fixtureRun], next: null };
  const runs = fixtureView(data);
  render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
    />,
  );
  await screen.findByText("completed");
  act(() => runs.update({ status: "loading", data }));
  expect(screen.getByText("completed")).toBeVisible();
  expect(screen.queryByText("Reading runs…")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeDisabled();
  act(() => runs.update({ status: "error", error: "Read failed", data }));
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeEnabled();
});
