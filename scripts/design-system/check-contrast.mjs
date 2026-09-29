#!/usr/bin/env node
/**
 * Fails the build when a text role cannot be read on a surface it is used on.
 *
 * This exists because the token table found four broken pairings by rendering
 * them, and a defect found by looking is a defect that ships until someone
 * looks. The table stays as the readable view; this is the check that runs.
 *
 * It parses `tokens.css` rather than a duplicate list of values, so it cannot
 * drift from the system it audits: resolve each role through its `var()` chain
 * to a literal, per mode, then measure every pairing the roles allow.
 *
 * Text uses APCA, per DESIGN.md § Contrast. Control/state boundaries use the
 * separate WCAG 3:1 non-text target on their supported opaque surfaces.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apcaContrast, wcagRatio } from "./apca.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOKENS = join(ROOT, "src/shared/design-system/styles/tokens.css");

/** Body text. Anything a person must read to use the product. */
const TARGET_BODY = 60;
/** Large or non-essential text: timestamps, counts, meta. */
const TARGET_META = 45;

/**
 * Pairings that are deliberately below target, with the reason.
 *
 * An exception must name a role and say why, so the list stays short and
 * arguable rather than becoming a place to hide failures.
 *
 * A key is either a role — exempt on every surface — or `role on surface`,
 * exempt for that one pairing. Prefer the narrow form: a role-wide exemption
 * for a shortfall on one surface also silences a genuine failure on the next
 * surface that role reaches, which is the failure mode this list must not have.
 */
const EXCEPTIONS = new Map([
  [
    "--text-disabled",
    "Low contrast is the signal that a control is unavailable; WCAG exempts inactive controls. Never carries information a person needs.",
  ],
]);

// Explicitly approved Blue 11 design tradeoff; see DESIGN.md § Link contrast.
// Pin mode, both roles and both resolved colors. A different low-contrast color
// must fail again; every unlisted role/surface keeps its normal target.
const ACCEPTED_LINK_PAIRS = new Set([
  "light --text-link #0d74ce on --affordance-selected #e8e8e8",
  "light --text-link #0d74ce on --neutral-4 #dadada",
  "dark --text-link #70b8ff on --surface-panel #1a1a1a",
  "dark --text-link #70b8ff on --surface-popover #333333",
  "dark --text-link #70b8ff on --affordance-subtle #333333",
  "dark --text-link #70b8ff on --affordance-selected #333333",
  "dark --text-link #70b8ff on --neutral-4 #232323",
  "dark --text-link #70b8ff on --affordance-link-hover #0d2847",
]);
const acceptedLinkMeasurements = new Map();

// Designer-approved removal of the Away outline; see DESIGN.md § Identity shapes.
// Bind each exception to the exact mode, role, fill and surface color.
const ACCEPTED_AWAY_PAIRS = new Set([
  "light --status-away #ffba18 on --surface-base #f5f5f6",
  "light --status-away #ffba18 on --surface-panel #ffffff",
  "light --status-away #ffba18 on --surface-inset #f5f5f6",
  "light --status-away #ffba18 on --surface-popover #ffffff",
  "light --status-away #ffba18 on --affordance-selected #e8e8e8",
  "light --status-away #ffba18 on --affordance-panel-hover #f5f5f6",
  "light --status-away #ffba18 on --affordance-subtle-hover #efeff0",
  "light --status-away #ffba18 on --affordance-floating-hover #e8e8e8",
  "light --status-away #ffba18 on --neutral-4 #dadada",
]);
const acceptedAwayMeasurements = new Map();

/** Roles measured at the meta target rather than the body target. */
const META_ROLES = new Set(["--text-tertiary", "--text-metadata"]);

/**
 * Neutral surfaces any text may sit on.
 *
 * `--bg-hover` was a role and is now written as `--neutral-4`, so it is named by
 * its step here. It still belongs in this list: a row under the cursor is a
 * surface text sits on, whatever it is called.
 */
const SURFACES = [
  "--surface-base",
  "--surface-panel",
  "--surface-popover",
  "--surface-inset",
  "--affordance-subtle",
  "--affordance-selected",
  "--neutral-4",
];

/**
 * Text that must be readable on every neutral surface.
 *
 * **The palette steps in this list are the point, not an oversight.** Once a
 * screen may write `text-red-12` directly, the guard has to measure the step a
 * screen actually uses — otherwise it audits names nobody types. `--text-error`
 * and `--text-accent` used to be here; deleting the roles without moving their
 * steps into this list would have left the guard passing while measuring
 * nothing, which is precisely the failure that shipped error text at Lc 34.
 *
 * A step joins this list when a screen starts using it for text. `red-12` is
 * here because three error messages use it; `red-11` is not, because nothing
 * does — and it is the step that fails, at 59.7 on a dark panel.
 */
const TEXT_ROLES = [
  "--text-standard",
  "--text-subtle",
  "--text-metadata",
  "--text-danger",
  "--text-warning",
  "--text-success",
  "--text-accent",
  "--text-link",
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--text-disabled",
  "--purple-12", // accent text: links, active nav, chip labels
  "--red-12", // error text: failed session start, rejected form
  "--amber-12", // warning text in delivery notices and dialogs
  "--green-12", // completion text in the foundation alignment proposal
];

/**
 * Paired text and the fills it is defined against — including each fill's hover.
 *
 * The hover was the gap. A solid button had no `bg-*-hover`, so hovering one
 * fell through to the neutral `bg-hover` and painted white paired text on light
 * grey — Lc 13, invisible, and this guard could not see it because it only
 * measured the resting fill. A paired text colour is only correct if it clears
 * every fill it can actually sit on, and hover is one of them.
 */
const PAIRS = [
  ...["control", "control-hover", "control-pressed", "selected"].map(
    (state) => ["--text-standard", `--affordance-floating-${state}`],
  ),
  ["--text-standard", "--affordance-floating-hover"],
  ["--text-danger", "--affordance-floating-hover"],
  ["--text-inverse", "--surface-inverse"],
  ["--text-link", "--affordance-link-hover"],
  ...["subtle", "subtle-hover", "subtle-pressed"].map((state) => [
    "--text-standard",
    `--affordance-${state}`,
  ]),
  ...["prominent", "prominent-hover", "prominent-pressed"].map((state) => [
    "--text-inverse",
    `--affordance-${state}`,
  ]),
  ...["danger", "danger-hover", "danger-pressed"].map((state) => [
    "--text-danger",
    `--affordance-${state}`,
  ]),
  ["--text-on-accent", "--purple-9"],
  ["--text-on-accent", "--purple-10"],
  // `bg-neutral-11` with `text-neutral-1` — the inverse pair, written as steps
  // now that the roles are gone. Still measured as a pair, because the text
  // follows the fill: move the fill and this has to be re-measured.
  ["--neutral-1", "--neutral-11"],
  ["--neutral-1", "--neutral-12"],
];

/**
 * Tint surfaces and the coloured text that sits on them, as steps.
 *
 * DESIGN.md: "tint carries a meaning and takes coloured text". The accent tint
 * and its hover are both real surfaces — a chip at rest and a chip under the
 * cursor — and the hover is the harder one, which is where the gap was.
 */
const BOUNDARY_SURFACES = [
  "--surface-base",
  "--surface-panel",
  "--surface-inset",
  "--surface-popover",
];
const BOUNDARY_ROLES = [
  "--border-danger",
  "--border-warning",
  "--status-online",
  // Online retains its outline; Away now exposes the step-10 fill directly.
  "--status-avatar-online-border",
  "--status-away",
  "--status-offline",
];

const TINT_PAIRS = [
  ["--text-warning", "--affordance-warning"],
  ["--text-success", "--affordance-success"],
  ["--text-accent", "--affordance-accent"],
  ["--text-accent", "--affordance-accent-hover"],
  ["--text-on-accent", "--affordance-accent-prominent"],
  ["--text-on-accent", "--affordance-accent-prominent-hover"],
  ["--amber-12", "--amber-3"],
  ["--green-12", "--green-3"],
  ["--purple-12", "--purple-3"],
  ["--purple-12", "--purple-4"],
];

const css = readFileSync(TOKENS, "utf8");

/**
 * Collects declarations per mode, honouring source order so a later block wins
 * exactly as the cascade would. `.dark` inherits `:root` and overrides it, so
 * dark is light-then-dark rather than dark alone.
 */
function declarationsByMode() {
  const light = new Map();
  const dark = new Map();
  // Split on top-level selector blocks and track which we are inside.
  const blocks = css.matchAll(/(:root|\.dark)\s*\{([^}]*)\}/g);
  for (const [, selector, body] of blocks) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      const v = value.trim();
      if (selector === ":root") {
        light.set(name, v);
        // Dark starts from the light value and is overridden below.
        dark.set(name, v);
      } else {
        dark.set(name, v);
      }
    }
  }
  return { light, dark };
}

/** Follows a `var()` chain to its literal, or null if it is not a plain colour. */
function resolve(map, name, depth = 0) {
  if (depth > 10) return null;
  const value = map.get(name);
  if (!value) return null;
  const single = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (single) return resolve(map, single[1], depth + 1);
  return /^#[0-9a-fA-F]{3,6}$/.test(value) ? value : null;
}

const modes = declarationsByMode();
const failures = [];
const boundaryFailures = [];
const skipped = [];
/**
 * Pairing-scoped exceptions this run actually needed. An exception nobody hits
 * is either fixed or wrong, and either way should not sit in the list
 * unchallenged — same reasoning as the type guard's stale-override report.
 */
const claimedExceptions = new Set();

for (const [mode, map] of Object.entries(modes)) {
  const check = (textRole, surfaceRole) => {
    const text = resolve(map, textRole);
    const surface = resolve(map, surfaceRole);
    // A translucent or gradient value cannot be measured against one colour;
    // record it rather than passing it silently.
    if (!text || !surface) {
      skipped.push(`${mode}: ${textRole} on ${surfaceRole}`);
      return;
    }
    const lc = Math.abs(apcaContrast(text, surface));
    const target = META_ROLES.has(textRole) ? TARGET_META : TARGET_BODY;
    if (lc >= target) return;
    const linkPair = `${mode} ${textRole} ${text} on ${surfaceRole} ${surface}`;
    if (ACCEPTED_LINK_PAIRS.has(linkPair)) {
      acceptedLinkMeasurements.set(linkPair, {
        lc,
        wcag: wcagRatio(text, surface),
      });
      return;
    }
    // Role-wide first, then the narrow `role on surface` form.
    if (EXCEPTIONS.has(textRole)) return;
    if (EXCEPTIONS.has(`${textRole} on ${surfaceRole}`)) {
      claimedExceptions.add(`${textRole} on ${surfaceRole}`);
      return;
    }
    failures.push({
      mode,
      textRole,
      text,
      surfaceRole,
      surface,
      lc,
      target,
      wcag: wcagRatio(text, surface),
    });
  };

  for (const role of TEXT_ROLES) {
    for (const surface of SURFACES) check(role, surface);
  }
  for (const [role, fill] of PAIRS) check(role, fill);
  for (const [text, tint] of TINT_PAIRS) check(text, tint);
  const floatingBorder = resolve(map, "--border-floating-control");
  const floatingSurface = resolve(map, "--surface-popover");
  const floatingBoundary =
    floatingBorder && floatingSurface
      ? wcagRatio(floatingBorder, floatingSurface)
      : null;
  if (floatingBoundary === null || floatingBoundary < 3) {
    boundaryFailures.push(
      `${mode}: --border-floating-control on --surface-popover — ${floatingBoundary === null ? "unresolved color" : `${floatingBoundary.toFixed(3)}:1`}, needs 3:1`,
    );
  }
  for (const role of BOUNDARY_ROLES) {
    const surfaces =
      role.startsWith("--status-avatar-") || role === "--status-away"
        ? [
            ...BOUNDARY_SURFACES,
            "--affordance-selected",
            "--affordance-panel-hover",
            "--affordance-subtle-hover",
            "--affordance-floating-hover",
            "--neutral-4",
          ]
        : BOUNDARY_SURFACES;
    for (const surface of surfaces) {
      const borderColor = resolve(map, role);
      const surfaceColor = resolve(map, surface);
      const ratio =
        borderColor && surfaceColor
          ? wcagRatio(borderColor, surfaceColor)
          : null;
      const pair = `${mode} ${role} ${borderColor} on ${surface} ${surfaceColor}`;
      if (ratio !== null && ratio < 3 && ACCEPTED_AWAY_PAIRS.has(pair)) {
        acceptedAwayMeasurements.set(pair, ratio);
        continue;
      }
      if (ratio === null || ratio < 3) {
        boundaryFailures.push(
          `${mode}: ${role} on ${surface} — ${ratio === null ? "unresolved color" : `${ratio.toFixed(3)}:1`}, needs 3:1`,
        );
      }
    }
  }
}

// Guard the maths itself: if these drift, every verdict above is wrong.
const REFERENCE = [
  ["#000000", "#ffffff", 106.04],
  ["#ffffff", "#000000", -107.88],
  ["#888888", "#ffffff", 63.06],
];
for (const [text, bg, expected] of REFERENCE) {
  const got = apcaContrast(text, bg);
  if (Math.abs(got - expected) > 0.05) {
    console.error(
      `✗ APCA implementation drifted: ${text} on ${bg} gave ${got.toFixed(2)}, expected ${expected}`,
    );
    process.exit(1);
  }
}

if (skipped.length > 0) {
  console.log(`ℹ ${skipped.length} pairing(s) not measurable as flat colour:`);
  for (const s of skipped) console.log(`    ${s}`);
}

for (const [pair, { lc, wcag }] of acceptedLinkMeasurements) {
  console.log(
    `  (accepted link contrast) ${pair}: Lc ${lc.toFixed(3)} < ${TARGET_BODY}; WCAG ${wcag.toFixed(3)}:1 — approved Blue 11 tradeoff, not a contrast pass`,
  );
}
const staleLinkPairs = [...ACCEPTED_LINK_PAIRS].filter(
  (pair) => !acceptedLinkMeasurements.has(pair),
);
if (staleLinkPairs.length) {
  console.log("ℹ Accepted link pairs no longer used — review and remove:");
  for (const pair of staleLinkPairs) console.log(`  ${pair}`);
}

for (const [pair, ratio] of acceptedAwayMeasurements) {
  console.log(
    `  (accepted Away contrast) ${pair}: ${ratio.toFixed(3)}:1 < 3:1 — approved unoutlined badge, not a contrast pass`,
  );
}
const staleAwayPairs = [...ACCEPTED_AWAY_PAIRS].filter(
  (pair) => !acceptedAwayMeasurements.has(pair),
);
if (staleAwayPairs.length) {
  console.log("ℹ Accepted Away pairs no longer used — review and remove:");
  for (const pair of staleAwayPairs) console.log(`  ${pair}`);
}

if (boundaryFailures.length > 0) {
  console.error(
    `\n✗ Control/state boundaries:\n  ${boundaryFailures.join("\n  ")}`,
  );
}

if (failures.length > 0) {
  console.error(
    `\n✗ Contrast: ${failures.length} pairing(s) below their APCA target\n`,
  );
  for (const f of failures) {
    console.error(
      `  ${f.mode.padEnd(5)} ${f.textRole} (${f.text}) on ${f.surfaceRole} (${f.surface})`,
    );
    console.error(
      `        Lc ${f.lc.toFixed(1)} — needs ${f.target}   [WCAG ${f.wcag.toFixed(2)}:1]`,
    );
  }
  console.error(
    "\nRaise the ramp step the role points at, or add a documented exception\nin scripts/check-contrast.mjs with a reason. See DESIGN.md § Contrast.\n",
  );
  process.exit(1);
}

if (boundaryFailures.length > 0) process.exit(1);
console.log(
  "✓ Contrast: checked text and control/state boundaries in both modes; accepted exceptions are listed explicitly",
);
for (const [role, why] of EXCEPTIONS) {
  console.log(`  (exception) ${role} — ${why.split(";")[0]}`);
}

const stale = [...EXCEPTIONS.keys()].filter(
  (key) => key.includes(" on ") && !claimedExceptions.has(key),
);
if (stale.length > 0) {
  console.log("\nℹ Pairing exceptions no longer needed — delete them:");
  for (const key of stale) console.log(`  ${key}`);
}
