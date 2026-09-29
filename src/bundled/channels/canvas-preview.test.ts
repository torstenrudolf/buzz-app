import { expect, it } from "vitest";
import { canvasPreviewText } from "./canvas-preview";

it.each([
  [
    "# Google root-link preview submission deep dive",
    "Google root-link preview submission deep dive",
  ],
  [
    "  \n## **A** _shared_ `document` ~~draft~~\n\n> Another line",
    "A shared document draft Another line",
  ],
  [
    "[Root **link**](https://example.com) &amp; ![alt text](https://example.com/image.png)",
    "Root link & alt text",
  ],
  ["[Label][ref]\n\n[ref]: https://example.com", "Label"],
  ["<!-- hidden -->\n\n<script>alert('no')</script>\n\n# Visible", "Visible"],
  ["<img src=x onerror=alert(1)>\n\nSafe", "Safe"],
  ["One\n\ntwo\n\n- three\n- four", "One two three four"],
  ["   \n", ""],
  ["---\n\n<!-- hidden -->", ""],
])("projects Markdown as text: %s", (source, expected) => {
  expect(canvasPreviewText(source)).toBe(expected);
});

it("bounds the excerpt without splitting a Unicode code point", () => {
  expect(canvasPreviewText("🐈".repeat(241))).toBe(`${"🐈".repeat(240)}…`);
});
