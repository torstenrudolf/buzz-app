import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tokens = readFileSync(
  join(root, "src/shared/design-system/styles/tokens.css"),
  "utf8",
);

// Exercise the real CLI against isolated stylesheet mutations. No repository
// files are changed, and a green status proves the guard actually ran.
function check(css) {
  const fixture = mkdtempSync(join(tmpdir(), "buzz-contrast-"));
  try {
    mkdirSync(join(fixture, "scripts/design-system"), { recursive: true });
    mkdirSync(join(fixture, "src/shared/design-system/styles"), {
      recursive: true,
    });
    for (const name of ["check-contrast.mjs", "apca.mjs"])
      copyFileSync(
        join(root, "scripts/design-system", name),
        join(fixture, "scripts/design-system", name),
      );
    writeFileSync(
      join(fixture, "src/shared/design-system/styles/tokens.css"),
      css,
    );
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts/design-system/check-contrast.mjs")],
      { encoding: "utf8" },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("semantic contrast contract", () => {
  it("checks the current text and state-boundary pairs in both modes", () => {
    const result = check(tokens);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "checked text and control/state boundaries",
    );
    expect(result.output.match(/\(accepted link contrast\)/g)).toHaveLength(8);
    expect(result.output.match(/\(accepted Away contrast\)/g)).toHaveLength(9);
    expect(result.output).toContain("not a contrast pass");
    expect(result.output).not.toContain("exceptions no longer needed");
  });

  it.each([
    [
      "light foreground",
      "--blue-11: #0d74ce;",
      "--blue-11: #0d75ce;",
      "on --affordance-selected",
    ],
    [
      "dark foreground",
      "--blue-11: #70b8ff;",
      "--blue-11: #70b7ff;",
      "on --surface-panel",
    ],
    [
      "light surface",
      "--neutral-3: #e8e8e8;",
      "--neutral-3: #e7e7e7;",
      "on --affordance-selected",
    ],
    [
      "dark surface",
      "--neutral-5: #333333;",
      "--neutral-5: #343434;",
      "on --surface-popover",
    ],
    [
      "another surface role",
      "--surface-inset: var(--neutral-2);",
      "--surface-inset: var(--neutral-4);",
      "on --surface-inset",
    ],
    [
      "hover role",
      "--affordance-link-hover: var(--blue-3);",
      "--affordance-link-hover: var(--blue-4);",
      "on --affordance-link-hover",
    ],
    [
      "hover color",
      "--blue-3: #0d2847;",
      "--blue-3: #0d2848;",
      "on --affordance-link-hover",
    ],
  ])("rejects an unapproved change to %s", (_name, from, to, pairing) => {
    expect(tokens).toContain(from);
    const result = check(tokens.replaceAll(from, to));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(
      new RegExp(`--text-link \\([^\\n]+\\) ${pairing}`),
    );
  });

  it("does not extend link exceptions to another text role", () => {
    const result = check(
      tokens.replaceAll(
        "--text-accent: var(--purple-12);",
        "--text-accent: var(--blue-11);",
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(
      /dark\s+--text-accent .* on --surface-popover/,
    );
  });

  it.each(["danger", "warning"])(
    "rejects the former low-contrast %s boundary",
    (role) => {
      const hue = role === "danger" ? "red" : "amber";
      const result = check(
        tokens.replaceAll(
          new RegExp(`--border-${role}: var\\(--${hue}-\\d+\\);`, "g"),
          `--border-${role}: var(--${hue}-8);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --border-${role} on --surface-panel`,
      );
      expect(result.output).toContain(
        `dark: --border-${role} on --surface-popover`,
      );
    },
  );

  it.each([
    ["online", "green"],
    ["avatar-online-border", "green"],
    ["away", "amber"],
    ["offline", "neutral"],
  ])("checks %s status on supported surfaces in both modes", (role, hue) => {
    const result = check(
      tokens.replaceAll(
        new RegExp(`--status-${role}: var\\(--${hue}-\\d+\\);`, "g"),
        `--status-${role}: var(--${hue}-5);`,
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      `light: --status-${role} on --surface-panel`,
    );
    expect(result.output).toContain(
      `dark: --status-${role} on --surface-popover`,
    );
  });

  it.each([["online", "green"]])(
    "rejects a %s outline that disappears on hover or selection",
    (role, hue) => {
      const result = check(
        tokens.replaceAll(
          `--status-avatar-${role}-border: var(--${hue}-11);`,
          `--status-avatar-${role}-border: var(--${hue}-10);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --status-avatar-${role}-border on --affordance-selected`,
      );
    },
  );

  it.each([
    [
      "fill",
      "--amber-10: #ffba18;",
      "--amber-10: #ffba19;",
      "light: --status-away on --surface-panel",
    ],
    [
      "surface",
      "--neutral-4: #dadada;",
      "--neutral-4: #dbdbdb;",
      "light: --status-away on --neutral-4",
    ],
    [
      "dark mode",
      "--amber-10: #ffd60a;",
      "--amber-10: #333333;",
      "dark: --status-away on --surface-popover",
    ],
    [
      "other role",
      "--status-offline: var(--neutral-8);",
      "--status-offline: var(--amber-10);",
      "light: --status-offline on --surface-panel",
    ],
  ])(
    "does not extend the Away exception to a changed %s",
    (_name, from, to, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(pairing);
    },
  );

  it.each(["warning", "success", "accent"])(
    "checks %s text against its semantic fill, not only the palette",
    (role) => {
      const hue = { warning: "amber", success: "green", accent: "purple" }[
        role
      ];
      const result = check(
        tokens.replaceAll(
          `--affordance-${role}: var(--${hue}-3);`,
          `--affordance-${role}: var(--${hue}-9);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`--text-${role}`);
      expect(result.output).toContain(`on --affordance-${role}`);
    },
  );
});
