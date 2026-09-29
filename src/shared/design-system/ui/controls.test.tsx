// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { Button } from "./Button";
import { Field } from "./Field";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Radio, RadioGroup } from "./RadioGroup";
import { Checkbox } from "./Checkbox";
import { SearchField } from "./SearchField";
import { Composer } from "./Composer";

afterEach(cleanup);

test("composer enables submission only for an available non-empty draft", async () => {
  const user = userEvent.setup();
  const submit = vi.fn((event) => event.preventDefault());
  function Example() {
    const [value, setValue] = useState("");
    return (
      <Composer
        label="New message"
        value={value}
        onValueChange={setValue}
        onSubmit={submit}
      />
    );
  }
  render(<Example />);
  const input = screen.getByRole("textbox", { name: "New message" });
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeDisabled();
  await user.type(input, "Hello");
  expect(send).toBeEnabled();
  await user.click(send);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("a loading action keeps its name and blocks pointer, keyboard and form submission until released", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  const submit = vi.fn((event) => event.preventDefault());
  const view = render(
    <form onSubmit={submit}>
      <Button type="submit" loading onClick={action}>
        Save changes
      </Button>
    </form>,
  );
  const button = screen.getByRole("button", { name: "Save changes" });
  expect(button).toHaveAttribute("aria-busy", "true");
  await user.click(button);
  button.focus();
  await user.keyboard("{Enter} ");
  expect(action).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  view.rerender(
    <form onSubmit={submit}>
      <Button type="submit" onClick={action}>
        Save changes
      </Button>
    </form>,
  );
  await user.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("loading non-native actions prevent activation and navigation", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(
    <Button
      loading
      nativeButton={false}
      render={<a href="#example" />}
      onClick={action}
    >
      Open note
    </Button>,
  );
  const link = screen.getByRole("button", { name: "Open note" });
  let prevented = false;
  const observe = (event: MouseEvent) => {
    prevented = event.defaultPrevented;
  };
  document.addEventListener("click", observe);
  try {
    await user.click(link);
  } finally {
    document.removeEventListener("click", observe);
  }
  expect(action).not.toHaveBeenCalled();
  expect(prevented).toBe(true);
});

test("fields connect labels, help and errors and keep textarea edits controlled", async () => {
  const user = userEvent.setup();
  const ref = createRef<HTMLTextAreaElement>();
  function Example() {
    const [value, setValue] = useState("Draft");
    return (
      <>
        <Field label="Title" description="A short name" error="Name required">
          <Input required />
        </Field>
        <Field label="Description">
          <Textarea
            id="description-control"
            ref={ref}
            name="description"
            rows={4}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <output>{value}</output>
      </>
    );
  }
  render(<Example />);
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(screen.queryByText("A short name")).not.toBeInTheDocument();
  expect(title).toHaveAccessibleDescription(/Name required/);
  expect(title).toHaveAttribute("aria-invalid", "true");
  const description = screen.getByRole("textbox", { name: "Description" });
  expect(ref.current).toBe(description);
  expect(description).toHaveAttribute("id", "description-control");
  expect(description).toHaveAttribute("name", "description");
  expect(description).toHaveAttribute("rows", "4");
  await user.click(screen.getByText("Description", { selector: "label" }));
  expect(description).toHaveFocus();
  await user.type(description, " notes");
  expect(screen.getByRole("status")).toHaveTextContent("Draft notes");
});

test("radio and checkbox labels change the actual form values while disabled choices do not", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Preferences">
      <Field label="Color mode">
        <RadioGroup name="mode" defaultValue="light">
          <Radio value="light" label="Light" />
          <Radio value="dark" label="Dark" />
          <Radio value="unavailable" label="Unavailable" disabled />
        </RadioGroup>
      </Field>
      <Checkbox name="summary" value="yes" label="Include summary" />
    </form>,
  );
  await user.click(screen.getByText("Dark"));
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  await user.click(screen.getByText("Unavailable"));
  expect(screen.getByRole("radio", { name: "Unavailable" })).not.toBeChecked();
  await user.click(screen.getByText("Include summary"));
  expect(
    screen.getByRole("checkbox", { name: "Include summary" }),
  ).toBeChecked();
  expect(
    Object.fromEntries(
      new FormData(screen.getByRole("form") as HTMLFormElement),
    ),
  ).toEqual({ mode: "light", summary: "yes" });
});

test.each(["default", "capsule"] as const)(
  "%s search forwards keyboard events and ref, and clearing restores input focus",
  async (variant) => {
    const user = userEvent.setup();
    const ref = createRef<HTMLElement>();
    const onKeyDown = vi.fn();
    function Example() {
      const [value, setValue] = useState("draft");
      return (
        <SearchField
          variant={variant}
          label="Notes"
          value={value}
          onValueChange={setValue}
          inputRef={ref}
          onKeyDown={onKeyDown}
        />
      );
    }
    render(<Example />);
    const input = screen.getByRole("searchbox", { name: "Notes" });
    expect(ref.current).toBe(input);
    await user.click(screen.getByRole("button", { name: "Clear notes" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onKeyDown).toHaveBeenCalled();
  },
);

test.each([false, true])(
  "native reset restores uncontrolled choices and form values (external form: %s)",
  async (external) => {
    const user = userEvent.setup();
    const checkboxChange = vi.fn();
    const radioChange = vi.fn();
    const checkboxRef = createRef<HTMLInputElement>();
    const radioRef = createRef<HTMLInputElement>();
    const choices = (
      <>
        <Field label="Delivery">
          <RadioGroup
            name="delivery"
            defaultValue="all"
            form={external ? "preferences" : undefined}
            inputRef={radioRef}
            onValueChange={radioChange}
          >
            <Radio value="all" label="All updates" />
            <Radio value="mentions" label="Mentions only" />
          </RadioGroup>
        </Field>
        <Checkbox
          name="summary"
          value="yes"
          label="Include summary"
          defaultChecked
          form={external ? "preferences" : undefined}
          inputRef={checkboxRef}
          onCheckedChange={checkboxChange}
        />
      </>
    );
    render(
      <>
        <form id="preferences" aria-label="Preferences">
          {!external && choices}
          <button type="reset">Reset preferences</button>
        </form>
        {external && choices}
      </>,
    );
    const form = screen.getByRole("form") as HTMLFormElement;
    const checkbox = screen.getByRole("checkbox", { name: "Include summary" });
    const all = screen.getByRole("radio", { name: "All updates" });
    const mentions = screen.getByRole("radio", { name: "Mentions only" });
    for (const programmatic of [false, true]) {
      await user.click(checkbox);
      await user.click(mentions);
      expect(checkbox).not.toBeChecked();
      expect(mentions).toBeChecked();
      expect(Object.fromEntries(new FormData(form))).toEqual({
        delivery: "mentions",
      });
      checkboxChange.mockClear();
      radioChange.mockClear();
      if (programmatic) await act(async () => form.reset());
      else
        await user.click(
          screen.getByRole("button", { name: "Reset preferences" }),
        );
      await waitFor(() => expect(checkbox).toBeChecked());
      expect(all).toBeChecked();
      expect(mentions).not.toBeChecked();
      expect(Object.fromEntries(new FormData(form))).toEqual({
        delivery: "all",
        summary: "yes",
      });
      expect(checkboxRef.current?.checked).toBe(true);
      expect(radioRef.current?.value).toBe("all");
      expect(checkboxChange).not.toHaveBeenCalled();
      expect(radioChange).not.toHaveBeenCalled();
    }
  },
);

test("canceling a native reset preserves choices and form values", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Preferences" onReset={(event) => event.preventDefault()}>
      <Checkbox
        name="summary"
        value="yes"
        label="Include summary"
        defaultChecked
      />
      <Field label="Delivery">
        <RadioGroup name="delivery" defaultValue="all">
          <Radio value="all" label="All updates" />
          <Radio value="mentions" label="Mentions only" />
        </RadioGroup>
      </Field>
      <button type="reset">Reset preferences</button>
    </form>,
  );
  const checkbox = screen.getByRole("checkbox", { name: "Include summary" });
  const mentions = screen.getByRole("radio", { name: "Mentions only" });
  await user.click(checkbox);
  await user.click(mentions);
  await user.click(screen.getByRole("button", { name: "Reset preferences" }));
  expect(checkbox).not.toBeChecked();
  expect(mentions).toBeChecked();
  expect(
    Object.fromEntries(
      new FormData(screen.getByRole("form") as HTMLFormElement),
    ),
  ).toEqual({ delivery: "mentions" });
});

test("controlled choices leave reset values with their owner", async () => {
  const user = userEvent.setup();
  function Example() {
    const [checked, setChecked] = useState(true);
    const [delivery, setDelivery] = useState("all");
    return (
      <form
        aria-label="Preferences"
        onReset={() => {
          setChecked(false);
          setDelivery("mentions");
        }}
      >
        <Checkbox
          name="summary"
          value="yes"
          label="Include summary"
          checked={checked}
          onCheckedChange={setChecked}
        />
        <Field label="Delivery">
          <RadioGroup
            name="delivery"
            value={delivery}
            onValueChange={setDelivery}
          >
            <Radio value="all" label="All updates" />
            <Radio value="mentions" label="Mentions only" />
          </RadioGroup>
        </Field>
        <button type="reset">Reset preferences</button>
      </form>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Reset preferences" }));
  expect(
    screen.getByRole("checkbox", { name: "Include summary" }),
  ).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Mentions only" })).toBeChecked();
  expect(
    Object.fromEntries(
      new FormData(screen.getByRole("form") as HTMLFormElement),
    ),
  ).toEqual({ delivery: "mentions" });
});

test("reset restores an initially empty radio group and unchecked checkbox", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Preferences">
      <Checkbox
        name="summary"
        value="yes"
        uncheckedValue="no"
        label="Include summary"
      />
      <Field label="Delivery">
        <RadioGroup name="delivery">
          <Radio value="all" label="All updates" />
          <Radio value="mentions" label="Mentions only" />
        </RadioGroup>
      </Field>
      <button type="reset">Reset preferences</button>
    </form>,
  );
  await user.click(screen.getByRole("checkbox", { name: "Include summary" }));
  await user.click(screen.getByRole("radio", { name: "Mentions only" }));
  await user.click(screen.getByRole("button", { name: "Reset preferences" }));
  expect(
    screen.getByRole("checkbox", { name: "Include summary" }),
  ).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "All updates" })).not.toBeChecked();
  expect(
    screen.getByRole("radio", { name: "Mentions only" }),
  ).not.toBeChecked();
  expect(
    Object.fromEntries(
      new FormData(screen.getByRole("form") as HTMLFormElement),
    ),
  ).toEqual({ summary: "no" });
});

test.each([false, true])(
  "controlled choices retain submitted values when reset does not change the owner (external form: %s)",
  async (external) => {
    const user = userEvent.setup();
    const checkboxChange = vi.fn();
    const radioChange = vi.fn();
    function Example() {
      const [updated, setUpdated] = useState(false);
      const choices = (
        <>
          <Checkbox
            label="Include summary"
            name="summary"
            value="yes"
            checked={updated}
            onCheckedChange={checkboxChange}
            form={external ? "preferences" : undefined}
          />
          <Field label="Delivery">
            <RadioGroup
              name="delivery"
              value={updated ? "mentions" : "all"}
              onValueChange={radioChange}
              form={external ? "preferences" : undefined}
            >
              <Radio label="All updates" value="all" />
              <Radio label="Mentions only" value="mentions" />
            </RadioGroup>
          </Field>
        </>
      );
      return (
        <>
          <form id="preferences" aria-label="Preferences">
            {!external && choices}
            <button type="button" onClick={() => setUpdated(true)}>
              Update owner
            </button>
            <button type="reset">Reset preferences</button>
          </form>
          {external && choices}
        </>
      );
    }
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "Update owner" }));
    const form = screen.getByRole("form") as HTMLFormElement;
    const values = { delivery: "mentions", summary: "yes" };
    expect(Object.fromEntries(new FormData(form))).toEqual(values);
    await user.click(screen.getByRole("button", { name: "Reset preferences" }));
    expect(
      screen.getByRole("checkbox", { name: "Include summary" }),
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: "Mentions only" })).toBeChecked();
    expect(Object.fromEntries(new FormData(form))).toEqual(values);
    expect(checkboxChange).not.toHaveBeenCalled();
    expect(radioChange).not.toHaveBeenCalled();
  },
);

test.each(["disabled", "late-mounted"])(
  "reset binds to radios that become available after group mount (%s)",
  async (mode) => {
    const user = userEvent.setup();
    const choices = (
      <>
        <Radio label="All updates" value="all" />
        <Radio label="Mentions only" value="mentions" />
      </>
    );
    function DelayedChoices() {
      const [ready, setReady] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setReady(true)}>
            Show choices
          </button>
          {ready && choices}
        </>
      );
    }
    function Example() {
      const [disabled, setDisabled] = useState(mode === "disabled");
      return (
        <form aria-label="Preferences">
          <button type="button" onClick={() => setDisabled(false)}>
            Enable choices
          </button>
          <Field label="Delivery">
            <RadioGroup name="delivery" defaultValue="all" disabled={disabled}>
              {mode === "late-mounted" ? <DelayedChoices /> : choices}
            </RadioGroup>
          </Field>
          <button type="reset">Reset preferences</button>
        </form>
      );
    }
    render(<Example />);
    await user.click(
      screen.getByRole("button", {
        name: mode === "disabled" ? "Enable choices" : "Show choices",
      }),
    );
    await user.click(screen.getByRole("radio", { name: "Mentions only" }));
    await user.click(screen.getByRole("button", { name: "Reset preferences" }));
    expect(screen.getByRole("radio", { name: "All updates" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Mentions only" }),
    ).not.toBeChecked();
    expect(
      Object.fromEntries(
        new FormData(screen.getByRole("form") as HTMLFormElement),
      ),
    ).toEqual({ delivery: "all" });
  },
);

test("field errors replace help until recovery without losing the entered value", async () => {
  const user = userEvent.setup();
  function Example({ error }: { error?: string }) {
    return (
      <Field label="Project" description="Use a short name." error={error}>
        <Input defaultValue="Studio" />
      </Field>
    );
  }
  const { rerender } = render(<Example />);
  const input = screen.getByRole("textbox", { name: "Project" });
  expect(input).toHaveAccessibleDescription("Use a short name.");
  await user.type(input, " project");
  rerender(<Example error="That name is already in use." />);
  expect(screen.queryByText("Use a short name.")).not.toBeInTheDocument();
  expect(input).toHaveAccessibleDescription("That name is already in use.");
  expect(input).toHaveAttribute("aria-invalid", "true");
  rerender(<Example />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(input).toHaveAccessibleDescription("Use a short name.");
  expect(input).not.toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveValue("Studio project");
});

test("search connects errors and disables clear in read-only mode", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <SearchField
      label="Search records"
      value="design"
      onValueChange={change}
      readOnly
      description="Filter the list."
      error="Search is unavailable."
    />,
  );
  const input = screen.getByRole("searchbox", { name: "Search records" });
  expect(input).toHaveAccessibleDescription("Search is unavailable.");
  expect(input).toHaveAttribute("aria-invalid", "true");
  const clear = screen.getByRole("button", { name: "Clear search records" });
  expect(clear).toBeDisabled();
  await user.click(clear);
  await user.type(input, "changed");
  expect(input).toHaveValue("design");
  expect(change).not.toHaveBeenCalled();
});

test("search and code fields suppress correction without changing prose or explicit overrides", () => {
  render(
    <>
      <SearchField label="Identity" value="" onValueChange={() => {}} />
      <Textarea aria-label="Code" variant="code" />
      <Textarea aria-label="Prose" />
      <Input aria-label="Ordinary input" />
      <SearchField
        label="Override"
        value=""
        onValueChange={() => {}}
        autoCorrect="on"
        autoCapitalize="sentences"
        spellCheck
      />
      <Textarea
        aria-label="Code override"
        variant="code"
        autoCorrect="on"
        autoCapitalize="sentences"
        spellCheck
      />
    </>,
  );
  for (const field of [
    screen.getByRole("searchbox", { name: "Identity" }),
    screen.getByRole("textbox", { name: "Code" }),
  ]) {
    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("autocapitalize", "none");
    expect(field).toHaveAttribute("spellcheck", "false");
  }
  for (const name of ["Prose", "Ordinary input"]) {
    const field = screen.getByRole("textbox", { name });
    expect(field).not.toHaveAttribute("autocorrect");
    expect(field).not.toHaveAttribute("autocapitalize");
    expect(field).not.toHaveAttribute("spellcheck");
  }
  for (const field of [
    screen.getByRole("searchbox", { name: "Override" }),
    screen.getByRole("textbox", { name: "Code override" }),
  ]) {
    expect(field).toHaveAttribute("autocorrect", "on");
    expect(field).toHaveAttribute("autocapitalize", "sentences");
    expect(field).toHaveAttribute("spellcheck", "true");
  }
});
