// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./Select";
import { Combobox } from "./Combobox";

afterEach(cleanup);
const options = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
] as const;

it("selects a form option with the keyboard and restores trigger focus", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("one");
    return (
      <Select
        label="Choice"
        variant="field"
        value={value}
        groups={[{ label: "", options }]}
        onValueChange={setValue}
      />
    );
  }
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "Choice" });
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("option", { name: "Two" });
  await user.keyboard("{End}{Enter}");
  expect(trigger).toHaveTextContent("Two");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("disables both form choices and searchable input/browse controls", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const browse = vi.fn();
  render(
    <>
      <Select
        label="Choice"
        variant="field"
        disabled
        value="one"
        groups={[{ label: "", options }]}
        onValueChange={change}
      />
      <Combobox.Root items={options} disabled onValueChange={change}>
        <Combobox.Control
          label="Search"
          triggerLabel="Browse choices"
          onBrowse={browse}
        />
        <Combobox.Popup empty="No choices">
          <Combobox.List>
            {(item: (typeof options)[number]) => (
              <Combobox.Item value={item} key={item.value}>
                {item.label}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </>,
  );
  expect(screen.getByRole("combobox", { name: "Choice" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Search" })).toBeDisabled();
  const trigger = screen.getByRole("button", { name: "Browse choices" });
  expect(trigger).toBeDisabled();
  await user.click(trigger);
  expect(browse).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("filters and selects through the real shared combobox", async () => {
  const user = userEvent.setup();
  render(
    <Combobox.Root items={options}>
      <Combobox.Control label="Search" triggerLabel="Browse choices" />
      <Combobox.Popup empty="No choices">
        <Combobox.List>
          {(item: (typeof options)[number]) => (
            <Combobox.Item value={item} key={item.value}>
              {item.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>,
  );
  const input = screen.getByRole("combobox", { name: "Search" });
  await user.type(input, "Two");
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(input).toHaveValue("Two");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("prioritizes Select errors over help and submits its named value", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Example">
      <Select
        label="Destination"
        variant="field"
        name="destination"
        value="one"
        groups={[{ label: "", options }]}
        description="Choose a workspace."
        error="That workspace is unavailable."
        onValueChange={() => {}}
      />
    </form>,
  );
  const input = screen.getByRole("combobox", { name: "Destination" });
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription("That workspace is unavailable.");
  expect(
    new FormData(screen.getByRole("form") as HTMLFormElement).get(
      "destination",
    ),
  ).toBe("one");
  await user.click(screen.getByText("Destination", { exact: true }));
  expect(input).toHaveFocus();
});

it("prioritizes Combobox errors without duplicating its label", async () => {
  const user = userEvent.setup();
  render(
    <Combobox.Root items={options}>
      <Combobox.Control
        label="Search"
        triggerLabel="Browse choices"
        description="Search available choices."
        error="Choose an available item."
      />
      <Combobox.Popup empty="No choices">
        <Combobox.List>
          {(item: (typeof options)[number]) => (
            <Combobox.Item value={item} key={item.value}>
              {item.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>,
  );
  const input = screen.getByRole("combobox", { name: "Search" });
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription("Choose an available item.");
  await user.click(screen.getByText("Search", { exact: true }));
  expect(input).toHaveFocus();
});

it("read-only and disabled options cannot change the selected value", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <>
      <Select
        label="Read-only"
        variant="field"
        readOnly
        value="one"
        groups={[{ label: "", options }]}
        onValueChange={change}
      />
      <Select
        label="With unavailable option"
        variant="field"
        value="one"
        groups={[
          {
            label: "",
            options: [options[0], { ...options[1], disabled: true }],
          },
        ]}
        onValueChange={change}
      />
      <Combobox.Root
        items={options}
        readOnly
        defaultValue={options[0]}
        onValueChange={change}
      >
        <Combobox.Control
          label="Read-only search"
          triggerLabel="Browse read-only"
        />
        <Combobox.Popup empty="No choices">
          <Combobox.List>
            {(item: (typeof options)[number]) => (
              <Combobox.Item value={item} key={item.value}>
                {item.label}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </>,
  );
  await user.click(screen.getByRole("combobox", { name: "Read-only" }));
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(screen.getByRole("combobox", { name: "Read-only" })).toHaveTextContent(
    "One",
  );
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  const search = screen.getByRole("combobox", { name: "Read-only search" });
  await user.type(search, "Two");
  expect(search).toHaveValue("One");
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(search).toHaveValue("One");
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("combobox", { name: "With unavailable option" }),
  );
  const unavailable = await screen.findByRole("option", { name: "Two" });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  expect(change).not.toHaveBeenCalled();
});

it.each(["inline", "field", "compact"] as const)(
  "preserves an explicit empty-string choice in the %s Select",
  async (variant) => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState("");
      return (
        <Select
          label="Channel"
          variant={variant}
          value={value}
          placeholder="Choose a channel"
          groups={[
            {
              label: "",
              options: [{ value: "", label: "All channels" }, ...options],
            },
          ]}
          onValueChange={setValue}
        />
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(trigger).toHaveTextContent("All channels");
    expect(trigger.querySelector("[data-placeholder]")).toBeNull();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "One" }));
    expect(trigger).toHaveTextContent("One");
    await user.click(trigger);
    await user.click(
      await screen.findByRole("option", { name: "All channels" }),
    );
    expect(trigger).toHaveTextContent("All channels");
    expect(trigger.querySelector("[data-placeholder]")).toBeNull();
    expect(trigger).toHaveFocus();
  },
);

it("shows the placeholder when an empty value has no matching option", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("");
    return (
      <Select
        label="Channel"
        variant="field"
        value={value}
        placeholder="Choose a channel"
        groups={[{ label: "", options }]}
        onValueChange={setValue}
      />
    );
  }
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "Channel" });
  expect(trigger).toHaveTextContent("Choose a channel");
  expect(trigger.querySelector("[data-placeholder]")).not.toBeNull();
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "One" }));
  expect(trigger).toHaveTextContent("One");
});

it("keeps compact choices labelled and opens by click and keyboard", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("one");
    return (
      <Select
        label="Assignee for Review"
        variant="compact"
        value={value}
        valueLabel={value === "one" ? "First" : "Second"}
        valueTitle={`Identity: ${value}`}
        groups={[{ label: "", options }]}
        onValueChange={setValue}
      />
    );
  }
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "Assignee for Review" });
  expect(screen.getByText("Assignee for Review")).toHaveClass("sr-only");
  expect(trigger).toHaveAttribute("data-size", "sm");
  expect(trigger).toHaveAttribute("data-variant", "ghost");
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(trigger).toHaveTextContent("Second");
  expect(trigger.querySelector("[title]")).toHaveAttribute(
    "title",
    "Identity: two",
  );
  expect(trigger).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Two" })).toHaveFocus(),
  );
  await user.keyboard("{Home}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "One" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(trigger).toHaveTextContent("First");
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("defaults combobox queries to exact text while permitting explicit correction", () => {
  const view = render(
    <Combobox.Root items={options}>
      <Combobox.Control label="Query" triggerLabel="Browse" />
    </Combobox.Root>,
  );
  const input = screen.getByRole("combobox", { name: "Query" });
  expect(input).toHaveAttribute("autocorrect", "off");
  expect(input).toHaveAttribute("autocapitalize", "none");
  expect(input).toHaveAttribute("spellcheck", "false");
  view.rerender(
    <Combobox.Root items={options}>
      <Combobox.Control
        label="Query"
        triggerLabel="Browse"
        autoCorrect="on"
        autoCapitalize="sentences"
        spellCheck
      />
    </Combobox.Root>,
  );
  expect(input).toHaveAttribute("autocorrect", "on");
  expect(input).toHaveAttribute("autocapitalize", "sentences");
  expect(input).toHaveAttribute("spellcheck", "true");
});
