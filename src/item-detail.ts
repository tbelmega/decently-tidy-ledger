import { renderMarkdown } from "./markdown.ts";
import { parseItemFileText } from "decently-coordinated-loops/tools/parse.ts";
import type { ItemFile } from "decently-coordinated-loops/tools/types.ts";

/** An item file parsed for the human view's detail drawer: the same structured
 * frontmatter fields the board renders, plus the markdown body rendered to HTML. */
export interface ItemDetail extends ItemFile {
  /** The markdown after the frontmatter block, rendered to sanitized HTML. */
  bodyHtml: string;
  /** The raw YAML between the `---` fences, verbatim and unparsed (empty when the
   * file has no frontmatter). The item drawer's frontmatter toggle renders this
   * as-is so it reads as source being inspected rather than data the UI endorses. */
  frontmatter: string;
}

/** Split an item file into its frontmatter fields (via the shared parser), the raw
 * frontmatter text, and its rendered body. `path` is the repo-relative path recorded
 * on the result. */
export function buildItemDetail(path: string, rawText: string): ItemDetail {
  const item = parseItemFileText(path, rawText);
  const frontmatterBlock = rawText.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = frontmatterBlock ? rawText.slice(frontmatterBlock[0].length) : rawText;
  const bodyHtml = renderMarkdown(body);
  return { ...item, bodyHtml, frontmatter: frontmatterBlock ? frontmatterBlock[1] : "" };
}
