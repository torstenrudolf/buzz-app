// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PreferenceRow } from "./PreferenceRow";
import { Checkbox } from "./Checkbox";
import { Button } from "./Button";
import { SwitchPreferenceRow } from "./SwitchPreferenceRow";

afterEach(cleanup);

it("associates its label and description with the trailing switch", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <SwitchPreferenceRow
      label="Desktop alerts"
      description="Show notifications for new activity."
      checked={false}
      onCheckedChange={change}
    />,
  );
  const control = screen.getByRole("switch", { name: "Desktop alerts" });
  expect(control).toHaveAccessibleDescription(
    "Show notifications for new activity.",
  );
  await user.click(screen.getByText("Desktop alerts"));
  expect(change).toHaveBeenCalledExactlyOnceWith(true, expect.anything());
});

it("keeps an unavailable preference named and inoperable", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <SwitchPreferenceRow
      label="Unavailable preference"
      disabled
      checked={false}
      onCheckedChange={change}
    />,
  );
  const control = screen.getByRole("switch", {
    name: "Unavailable preference",
  });
  expect(control).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByText("Unavailable preference"));
  expect(change).not.toHaveBeenCalled();
});

it("supports an action name while keeping the visible label clickable", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <SwitchPreferenceRow
      label="GitHub"
      aria-label="Enable GitHub"
      checked={false}
      onCheckedChange={change}
    />,
  );
  expect(
    screen.getByRole("switch", { name: "Enable GitHub" }),
  ).toBeInTheDocument();
  await user.click(screen.getByText("GitHub"));
  expect(change).toHaveBeenCalledExactlyOnceWith(true, expect.anything());
});

it("labels a checkbox and lets its title activate it without including the icon", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <PreferenceRow
      title="Include archived"
      subtitle="Search archived channels too."
      icon={<svg role="img" aria-label="Archive icon" />}
      controlId="archive-choice"
      trailing={(labelProps) => (
        <Checkbox
          {...labelProps}
          id="archive-choice"
          label={null}
          checked={false}
          onCheckedChange={change}
        />
      )}
    />,
  );
  const control = screen.getByRole("checkbox", { name: "Include archived" });
  expect(control).toHaveAccessibleDescription("Search archived channels too.");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  await user.click(screen.getByText("Include archived"));
  expect(change).toHaveBeenCalledExactlyOnceWith(true, expect.anything());
});

it("keeps an action button independently named and does not make its row clickable", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(
    <PreferenceRow
      title="Accounts"
      subtitle="Connected accounts"
      trailing={<Button onClick={action}>Manage</Button>}
    />,
  );
  await user.click(screen.getByText("Accounts"));
  expect(action).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Manage" }));
  expect(action).toHaveBeenCalledTimes(1);
});

it("keeps a busy switch focusable without changing its value", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <SwitchPreferenceRow
      label="Plugin"
      checked
      readOnly
      aria-disabled
      onCheckedChange={change}
    />,
  );
  const control = screen.getByRole("switch", { name: "Plugin" });
  await user.tab();
  expect(control).toHaveFocus();
  await user.keyboard(" ");
  await user.click(screen.getByText("Plugin"));
  expect(change).not.toHaveBeenCalled();
  expect(control).toBeChecked();
});
