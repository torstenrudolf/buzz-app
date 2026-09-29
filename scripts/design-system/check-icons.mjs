import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "rolldown/utils";

const root = fileURLToPath(new URL("../../", import.meta.url));
const gateway = "src/shared/design-system/icons/";
const approved = new Set(["@phosphor-icons/react", "@phosphor-icons/core"]);
// A closed policy needs an explicit non-icon side as well as approved icon catalogs.
// Version changes remain ordinary; adding a package requires classifying it here.
const nonIconDependencies = new Set([
  "@base-ui/react",
  "@biomejs/biome",
  "@buzz/author",
  "@deepseek-ai/cordis",
  "@emoji-mart/data",
  "@fontsource-variable/inter",
  "@fontsource/jetbrains-mono",
  "@jsquash/webp", // Lossless media encoder, not an icon catalog.
  "@noble/curves",
  "@playwright/test",
  "@tailwindcss/postcss",
  "@tanstack/react-router",
  "@tauri-apps/api",
  "@tauri-apps/cli",
  "@tauri-apps/plugin-updater",
  "@testing-library/dom",
  "@testing-library/jest-dom",
  "@testing-library/react",
  "@testing-library/user-event",
  "@types/mdast",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "@xterm/addon-fit",
  "@xterm/xterm",
  "blurhash",
  "consola", // Runtime logging, not an icon catalog.
  "dockview-react",
  "emoji-mart",
  "flexlayout-react",
  "jsdom",
  "mdast", // Type-only module supplied by @types/mdast.
  "mdast-util-from-markdown",
  "mdast-util-gfm-strikethrough",
  "mdast-util-gfm-table",
  "mdast-util-to-markdown",
  "micromark-extension-gfm-strikethrough",
  "micromark-extension-gfm-table",
  "motion",
  "nostr-tools",
  "postcss",
  "prosemirror-commands",
  "prosemirror-history",
  "prosemirror-model",
  "prosemirror-schema-list",
  "prosemirror-state",
  "prosemirror-view",
  "react",
  "react-day-picker", // Calendar behavior; navigation icons use our Phosphor gateway.
  "react-diff-view", // Patch tables/parser, not an icon library.
  "react-dom",
  "react-markdown",
  "remark-breaks",
  "remark-gfm",
  "rolldown",
  "tailwindcss",
  "typescript",
  "undici",
  "virtua",
  "vite",
  "vitest",
  "yaml",
]);
const allowedDependencies = new Set([...approved, ...nonIconDependencies]);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
export function checkIconManifest(manifest) {
  return dependencyFields
    .flatMap((field) => Object.entries(manifest[field] ?? {}))
    .flatMap(([name, version]) => {
      const alias = version.startsWith("npm:")
        ? packageName(version.slice(4).replace(/@[^@]*$/, ""))
        : undefined;
      const target = alias ?? packageName(name);
      if (allowedDependencies.has(name) && target === name) return [];
      if (!alias && nonIconDependencies.has(target)) return [];
      return [
        `Unclassified dependency: ${name}. Approve non-icon packages explicitly; use only Phosphor for icons.`,
      ];
    });
}

// Reuse the build tool's syntax parser so JSX, regexes and template text are
// not mistaken for imports, and expressions inside templates remain visible.
export function checkIconSource(path, source) {
  const parsed = parseSync(path, source);
  if (parsed.errors.length)
    return parsed.errors.map(
      (error) => `Cannot inspect icon imports: ${error.message}`,
    );
  const errors = [];
  const inside = path.startsWith(gateway);
  const literal = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (inside && node.type === "ExportAllDeclaration")
      errors.push("Use explicit named icon exports, not wildcard exports.");
    let target;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type)
    )
      target = node.source;
    else if (node.type === "TSExternalModuleReference")
      target = node.expression;
    else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    )
      target = node.arguments[0];
    const specifier = literal(target);
    const dependency =
      typeof specifier === "string" ? packageName(specifier) : undefined;
    if (
      dependency !== undefined &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("#")
    ) {
      if (!allowedDependencies.has(dependency))
        errors.push(
          `Use shared/design-system/icons instead of unclassified external dependency ${specifier}.`,
        );
      else if (approved.has(dependency)) {
        if (!inside)
          errors.push(
            `Use shared/design-system/icons instead of ${specifier}.`,
          );
        else if (
          !/^@phosphor-icons\/(?:react\/dist\/csr\/[A-Z][A-Za-z0-9]*|core\/assets\/(?:thin|light|regular|bold|fill|duotone)\/[a-z0-9-]+\.svg\?raw)$/.test(
            specifier,
          )
        )
          errors.push(
            `Import individual Phosphor modules/assets, not the full catalog: ${specifier}`,
          );
      } else if (inside && dependency !== "react")
        errors.push(`The icon gateway cannot depend on ${specifier}.`);
    }
    for (const value of Object.values(node))
      if (value && typeof value === "object") visit(value);
  }
  visit(parsed.program);
  return errors;
}
export function checkIcons() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const errors = [];
  for (const path of new Set(paths)) {
    if (!existsSync(`${root}${path}`)) continue;
    if (path === "package.json" || path.endsWith("/package.json"))
      errors.push(
        ...checkIconManifest(
          JSON.parse(readFileSync(`${root}${path}`, "utf8")),
        ).map((error) => `${path}: ${error}`),
      );
    if (/\.[cm]?[jt]sx?$/.test(path))
      errors.push(
        ...checkIconSource(path, readFileSync(`${root}${path}`, "utf8")).map(
          (error) => `${path}: ${error}`,
        ),
      );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Icon dependencies and source import boundary checked.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) checkIcons();
