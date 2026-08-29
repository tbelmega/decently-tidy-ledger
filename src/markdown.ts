// The board's one markdown renderer. Extracted from item-detail.ts when the outbox
// panel became a second consumer  -  two hardened renderers would drift, and this one is
// a security boundary rather than a formatting preference.
//
// Item bodies and outbox entries are developer- and agent-authored markdown, and agents
// routinely paste material they did not write (bug reports, fetched pages, research
// notes). The board serves this on localhost with no origin isolation, and the outbox
// adds a write endpoint on the same listener, so raw HTML in a body would run as script
// in the operator's session. Raw HTML therefore becomes visible text and unsafe URL
// schemes lose their link.
import { Marked, Renderer, type Tokens } from "marked";

export function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

/** Link targets the board will emit. Anything else  -  `javascript:`, `data:`, an unknown
 * scheme  -  renders as inert text rather than a clickable link. */
export const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/|\.{1,2}\/|[\w.-]+\.md(?:#|$)|[\w.-]+\/)/i;

/** `[[slug]]`, the wiki-style cross-reference used in item bodies and outbox entries. */
const WIKILINK = /\[\[([a-z0-9-]+)\]\]/g;

function buildRenderer(): Renderer {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  // images are the other raw-fetch vector: keep the alt text, drop the request
  renderer.image = ({ href, title, text }) =>
    escapeHtml(title ? `![${text}](${href} "${title}")` : `![${text}](${href})`);
  renderer.link = function (token: Tokens.Link) {
    const href = String(token.href ?? "");
    const inner = this.parser.parseInline(token.tokens ?? []);
    if (!SAFE_HREF.test(href)) return inner;
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    // a body link must not navigate the board tab away from the operator's context
    return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`;
  };
  return renderer;
}

const markdown = new Marked({ renderer: buildRenderer(), async: false });

/** Rewrite `[[slug]]` before `marked` sees it, so the result goes through the same
 * escaping and link hardening as any other link.
 *
 * A slug that is not a known item stays plain text rather than becoming a dead link  -
 * entries reference items that were archived or never existed, and a link that 404s is
 * worse than prose. `knownSlugs` empty means every wikilink renders as text, which is
 * the correct degradation when the item payload could not be read. */
function expandWikilinks(text: string, known: KnownItems): string {
  return text.replace(WIKILINK, (whole, slug: string) => {
    const path = known.get(slug);
    // the path, not a guessed `items/` prefix: an accepted item lives in archive/ and a
    // verified one in for-delivery/, and a link to the wrong folder 404s
    return path ? `[${slug}](${path})` : whole;
  });
}

/** slug → repo-relative path. A plain set cannot say WHERE an item lives, and items
 * move between items/, for-delivery/ and archive/ as they advance. */
export type KnownItems = ReadonlyMap<string, string>;

/** Render markdown to sanitized HTML. `known` drives `[[wikilink]]` resolution only;
 * pass an empty map where wikilinks should always stay literal. */
export function renderMarkdown(text: string, known: KnownItems = new Map()): string {
  const rendered = markdown.parse(expandWikilinks(text.trim(), known), { async: false });
  if (typeof rendered !== "string") throw new Error("synchronous Markdown rendering returned a promise");
  return rendered;
}
