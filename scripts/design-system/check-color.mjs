#!/usr/bin/env node
/**
 * Colour-system guard.
 *
 * One rule, and it exists because of a specific near-miss: the accent tint
 * looked right in light mode at Tailwind's `purple-100`, but its dark
 * counterpart looked oversaturated, and the obvious fix was to write
 * `purple-950/50` — dim a too-strong colour until it looks subtle.
 *
 * That value was not wrong. `purple-950/50` composites to roughly the same
 * muted deep purple the palette now holds as a step, and two independent
 * attempts landed within a few percent of it. The problem is where it lives: an
 * opacity expression inside a component is a colour decision with no name, no
 * light/dark pair, and no way for the contrast guard to measure it.
 *
 * So the rule is not "never use opacity". It is: **opacity is not how you reach
 * a lighter or subtler colour.** If a step is missing, add it to the palette —
 * that is a reviewed diff instead of a value buried in a class list.
 *
 * Genuine translucency, where something behind must show through, is a
 * different axis and has its own tokens: `glass-*`, and the `--texture-*` and
 * shadow values that bake alpha into a literal.
 *
 * It also audits the layering itself: that the palette is the only place a
 * literal lives, that an identity role references a palette step rather than
 * holding its own value, and that two roles doing the same job resolve to the
 * same step rather than merely to the same value today. That last one is not
 * hypothetical — `accent-2` and `tint-purple` were the same purple in light mode
 * and two different purples in dark, and nothing caught it because both were
 * hand-picked.
 *
 * Run: pnpm check:color
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(
  new URL("../../src/shared/design-system", import.meta.url),
);
const VIEWER = fileURLToPath(
  new URL("../../tests/fixtures/design-system", import.meta.url),
);
const TOKENS_FILE = fileURLToPath(
  new URL("../../src/shared/design-system/styles/tokens.css", import.meta.url),
);

/**
 * Colour utilities that may not carry an opacity modifier.
 *
 * Deliberately the colour-bearing prefixes only. `opacity-50` on a whole
 * element is a legitimate way to fade a thing out, and `bg-black/50` on a
 * scrim is genuine translucency — the first is not a colour choice and the
 * second is caught by review, not by this guard.
 */
const COLOR_PREFIXES = [
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "shadow",
  "outline",
  "divide",
  "decoration",
  "accent",
  "caret",
  "from",
  "via",
  "to",
];

/**
 * `bg-accent-tint/50`, `text-primary/80`. The slash-number form is Tailwind's
 * opacity modifier, and on a colour utility it always means "I want a different
 * shade of this".
 */
const OPACITY_MODIFIER = new RegExp(
  String.raw`\b(?:${COLOR_PREFIXES.join("|")})-[a-z0-9-]+\/(\d{1,3}|\[[^\]]+\])`,
  "g",
);

/**
 * `color-mix(in srgb, var(--x) 50%, transparent)` and friends: the same move
 * spelled in CSS. Also catches raw `rgba()`/`hsla()` with a fractional alpha on
 * a colour property.
 */
const CSS_MIXERS = [
  { pattern: /color-mix\s*\(/g, what: "color-mix()" },
  { pattern: /\brgba?\([^)]*\/\s*0?\.\d+\s*\)/g, what: "rgb() with alpha" },
  { pattern: /\brgba\([^)]*,\s*0?\.\d+\s*\)/g, what: "rgba()" },
  { pattern: /\bhsla?\([^)]*[,/]\s*0?\.\d+\s*\)/g, what: "hsl() with alpha" },
];

/** Every hue in the palette. `neutral` is a hue like any other. */
const PALETTE_HUES = [
  "neutral",
  "purple",
  "red",
  "green",
  "amber",
  "blue",
  "cyan",
  "orange",
];

/** Glass is consumed as a complete material, never as a bare fill. Direct
 * palette consumption in production is checked by check-adoption.mjs; viewer
 * swatches may inspect the palette. */
const PRIVATE_TOKEN = /var\(\s*--glass-\d+\s*\)/g;

/**
 * Files exempt from the private-token rule, with the reason.
 *
 * The token file defines the layers, so it necessarily references them. The
 * design-system pages exist to *show* the ramps, so they resolve token names on
 * purpose — that is their subject matter, not a shortcut.
 */
const PRIVATE_TOKEN_ALLOWED = new Map([
  ["styles/tokens.css", "Defines the layers it references."],
  [
    "styles/materials.css",
    "The glass materials live here; pairing each fill with its blur and rim is their job.",
  ],
  [
    "tokens/registry.ts",
    "Documents the ramps; the token names are its content.",
  ],
  [
    "../../../tests/fixtures/design-system/useResolvedToken.ts",
    "Resolves ramp steps so the design-system pages can display them.",
  ],
]);

/**
 * Files where building a colour value IS the job, with the reason.
 *
 * The token file is the one place alpha is legitimately baked into a literal —
 * glass fills, dot textures, shadow colours. That is the documented other side
 * of the rule: transparency for genuine see-through lives inside a value, at
 * the bottom layer, named.
 */
const MIXER_ALLOWED = new Map([
  [
    "styles/tokens.css",
    "Bakes alpha into named values (glass, texture, shadow) — the layer where that belongs.",
  ],
]);

/** Specific `path:line` escapes, each with a reason. */
const OVERRIDES = new Map([
  // Preserve the existing, designer-approved availability capsule when moving
  // its recipe out of feature CSS. These are not new contrast exemptions:
  // docs/presence.md records the measured Online shortfall in both themes.
  ["styles/materials.css:179", "Availability resting status mix: 12%."],
  ["styles/materials.css:184", "Availability hover status mix: 18%."],
  ["styles/materials.css:189", "Availability pressed/open status mix: 24%."],
]);

const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(tsx?|css)$/.test(entry)) continue;
    check(full);
  }
}

function check(file) {
  const rel = relative(SRC, file);
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;
    if (OVERRIDES.has(at)) return;
    // A comment explaining the rule is not a violation of it.
    const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");

    for (const match of code.matchAll(OPACITY_MODIFIER)) {
      failures.push({
        at,
        found: match[0],
        why: "Opacity is not how you reach a subtler colour. Add a palette step, or use a different step.",
      });
    }

    for (const { pattern, what } of MIXER_ALLOWED.has(rel) ? [] : CSS_MIXERS) {
      for (const match of code.matchAll(pattern)) {
        failures.push({
          at,
          found: match[0],
          why: `${what} builds a colour instead of naming one. Add a palette step; bake alpha into a value only for genuine translucency.`,
        });
      }
    }

    if (!PRIVATE_TOKEN_ALLOWED.has(rel)) {
      for (const match of code.matchAll(PRIVATE_TOKEN)) {
        failures.push({
          at,
          found: match[0],
          why: "A glass fill on its own is not glass. Use the `glass-primary` or `glass-secondary` utility, which carries the blur, rim, and lift with it.",
        });
      }
    }
  });
}

walk(SRC);
walk(VIEWER);
auditLayers();

/**
 * The layering rules, measured against `tokens.css` rather than a copied list,
 * so this cannot drift from the system it audits.
 */
function auditLayers() {
  const css = readFileSync(TOKENS_FILE, "utf8");
  const rel = "styles/tokens.css";

  /** Every `:root` or `.dark` block, concatenated. One per layer, so several. */
  const blocksFor = (selector) => {
    const out = [];
    const pattern = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{`, "g");
    for (const match of css.matchAll(pattern)) {
      let depth = 1;
      let i = match.index + match[0].length;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") depth -= 1;
        i += 1;
      }
      out.push(css.slice(start, i - 1));
    }
    return out.join("\n");
  };

  const modes = { light: blocksFor(":root"), dark: blocksFor(".dark") };
  const read = (block, name) =>
    new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(block)?.[1].trim();

  const HUES = PALETTE_HUES;
  // Backdrop scenes are intentionally mode-specific at the palette layer, but
  // their semantic gradient slot must be complete and paired. A slot with a
  // missing counterpart would silently turn an appearance preference into an
  // invalid state on a mode change, so verify the production CSS seam here.
  const BACKDROP_PAIRS = [
    ["--gradient-1", "--gradient-sky-field", "--gradient-night-garden"],
    ["--gradient-2", "--gradient-peach-field", "--gradient-signal-flare"],
    ["--gradient-3", "--gradient-blue-hour", "--gradient-electric-dusk"],
    ["--gradient-4", "--gradient-orchid-field", "--gradient-ultraviolet"],
  ];
  for (const [slot, lightScene, darkScene] of BACKDROP_PAIRS) {
    for (const [mode, scene] of [
      ["light", lightScene],
      ["dark", darkScene],
    ]) {
      if (!read(modes[mode], scene)) {
        failures.push({
          at: `${rel} (${mode})`,
          found: scene,
          why: "Missing named backdrop treatment for this semantic gradient slot.",
        });
      }
      if (read(modes[mode], slot) !== `var(${scene})`) {
        failures.push({
          at: `${rel} (${mode})`,
          found: `${slot}: ${read(modes[mode], slot) ?? "missing"}`,
          why: `Must pair this slot with ${scene} in ${mode} mode.`,
        });
      }
    }
  }

  // 1. Every palette step exists in both modes and holds a literal.
  for (const hue of HUES) {
    for (let step = 1; step <= 12; step += 1) {
      const name = `--${hue}-${step}`;
      for (const [mode, block] of Object.entries(modes)) {
        const value = read(block, name);
        if (!value) {
          failures.push({
            at: `${rel} (${mode})`,
            found: name,
            why: "Missing. Every palette step must be authored in both modes.",
          });
        } else if (!/^#[0-9a-f]{6}$/i.test(value)) {
          failures.push({
            at: `${rel} (${mode})`,
            found: `${name}: ${value}`,
            why: "A palette step holds a literal. Values live here and nowhere else.",
          });
        }
      }
    }
  }

  // Semantic names describe purpose even when both themes choose the same step.
  // Require every new semantic role to declare both modes and reference a token.
  const roles = [
    ...modes.light.matchAll(
      /^\s*(--(?:surface|affordance|text|border|status)-[a-z0-9-]+):/gm,
    ),
  ];
  for (const [, name] of roles) {
    for (const [mode, code] of Object.entries(modes)) {
      if (name === "--text-on-accent") continue; // Fixed white paired with the accent fill; measured by check-contrast.
      const value =
        read(code, name) ??
        (mode === "dark" ? read(modes.light, name) : undefined);
      if (!value || !/^var\(--[a-z0-9-]+\)$/.test(value)) {
        failures.push({
          at: rel,
          found: `${name} (${mode}): ${value ?? "missing"}`,
          why: "Semantic roles must reference a shared token in both modes.",
        });
      }
    }
  }
}

if (failures.length === 0) {
  console.log(
    "✓ Color: layers intact, no colour built by opacity, no private token used",
  );
  for (const [path, reason] of new Map([
    ...PRIVATE_TOKEN_ALLOWED,
    ...MIXER_ALLOWED,
  ])) {
    console.log(`  (exception) ${path} — ${reason}`);
  }
  process.exit(0);
}

console.error(`✗ Color: ${failures.length} violation(s)\n`);
for (const { at, found, why } of failures) {
  console.error(`  ${at}`);
  console.error(`        ${found}`);
  console.error(`        ${why}\n`);
}
console.error(
  "Add the step to the palette in tokens.css, or add a documented override\nin scripts/design-system/check-color.mjs with a reason. See DESIGN.md § Colour discipline.",
);
process.exit(1);
