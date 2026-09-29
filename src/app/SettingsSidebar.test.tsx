// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";

afterEach(cleanup);

it("keeps permission-gated cards in a separate Administration group", () => {
  const client = {
    selected: "primary",
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const connection = { scope: "settings-sidebar-admin-test" };
  const cards: ReturnType<SettingsCards["snapshot"]> = [
    {
      id: "membership",
      key: "moderation/membership",
      pluginId: "moderation",
      revision: "one",
      title: "Membership",
      section: "administration",
      component: () => null,
    },
  ];
  render(
    <SettingsSidebar
      communities={
        {
          subscribe: () => () => {},
          snapshot: () => client,
          relay: {
            subscribe: () => () => {},
            snapshot: () => connection,
          },
        } as unknown as Communities
      }
      cards={
        {
          subscribe: () => () => {},
          snapshot: () => cards,
        } as unknown as SettingsCards
      }
      selected="moderation/membership"
      onBack={() => {}}
      onSection={() => {}}
    />,
  );

  const membership = screen.getByRole("button", { name: "Membership" });
  expect(membership).toHaveAttribute("aria-current", "page");
  expect(membership.closest("section")).toHaveTextContent("Administration");
  expect(membership.closest("section")).not.toHaveTextContent("Primary");
});

it.each([null, "primary"])(
  "keeps one usable Profile entry with community %s",
  async (selected) => {
    const client = {
      selected,
      memberships: [{ id: "primary", name: "Primary" }],
    };
    const connection = { scope: "settings-sidebar-profile-test" };
    const cards: ReturnType<SettingsCards["snapshot"]> = [];
    const onSection = vi.fn();
    render(
      <SettingsSidebar
        communities={
          {
            subscribe: () => () => {},
            snapshot: () => client,
            relay: { subscribe: () => () => {}, snapshot: () => connection },
          } as unknown as Communities
        }
        cards={
          {
            subscribe: () => () => {},
            snapshot: () => cards,
          } as unknown as SettingsCards
        }
        selected="profile"
        onBack={() => {}}
        onSection={onSection}
      />,
    );
    const profile = screen.getByRole("button", {
      name: "Profile",
    });
    expect(profile).toHaveAttribute("aria-current", "page");
    expect(profile.closest("section")).toHaveTextContent(
      selected ? "Primary" : "App",
    );
    await userEvent.setup().click(profile);
    expect(onSection).toHaveBeenCalledWith("profile");
  },
);
