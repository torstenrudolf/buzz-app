import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

/** Plain text only: no HTML, link destinations, or remote media in the ingress. */
export function canvasPreviewText(content: string): string {
  const tree = fromMarkdown(content, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });
  const pending: Nodes[] = [...tree.children].reverse();
  const text: string[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || node.type === "html" || node.type === "definition") continue;
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "code" ||
      node.type === "break"
    )
      text.push(" ");
    if ("children" in node) pending.push(...[...node.children].reverse());
    else if ("value" in node) text.push(node.value);
    else if ("alt" in node) text.push(node.alt ?? "");
  }
  const preview = Array.from(text.join("").replace(/\s+/g, " ").trim());
  return preview.length > 240
    ? `${preview.slice(0, 240).join("")}…`
    : preview.join("");
}
