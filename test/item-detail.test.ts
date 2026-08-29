import { describe, expect, test } from "bun:test";
import { buildItemDetail } from "../src/item-detail.ts";

const RAW = `---
title: "Board human view"
project: example-data
state: implemented
owner: "-"
autonomy: supervised
next-actor: owner
awaiting: verify
next-step: "owner: run \`bun run board\`"
updated: 2026-07-10
links:
  spec: docs/specs/2026-07-09-board-human-view.md
---

Split the overloaded board into two artifacts.

## Log
- 2026-07-10: Implemented and ran \`bun test\`.
`;

describe("buildItemDetail", () => {
  const detail = buildItemDetail("items/example-data-board-human-view.md", RAW);

  test("keeps the structured frontmatter fields the board renders", () => {
    expect(detail.slug).toBe("example-data-board-human-view");
    expect(detail.title).toBe("Board human view");
    expect(detail.project).toBe("example-data");
    expect(detail.awaiting).toBe("verify");
    expect(detail.links.spec).toBe("docs/specs/2026-07-09-board-human-view.md");
  });

  test("renders the markdown body (below the frontmatter) to HTML", () => {
    expect(detail.bodyHtml).toContain("<h2");
    expect(detail.bodyHtml).toContain("Log");
    expect(detail.bodyHtml).toContain("<li>");
    expect(detail.bodyHtml).toContain("<code>bun test</code>");
  });

  test("excludes the frontmatter block from the rendered body", () => {
    expect(detail.bodyHtml).not.toContain("next-actor");
    expect(detail.bodyHtml).not.toContain("---");
  });

  test("surfaces the frontmatter verbatim and unparsed, without its --- fences", () => {
    // the item drawer's frontmatter toggle renders this raw, on purpose  -  it is
    // an instrument for observing what the facts panel doesn't already carry
    expect(detail.frontmatter).toContain("next-actor: owner");
    expect(detail.frontmatter).toContain('next-step: "owner: run `bun run board`"');
    expect(detail.frontmatter).not.toContain("---");
    expect(detail.frontmatter).not.toContain("Split the overloaded board");
  });

  test("keeps ordinary markdown working", () => {
    const d = buildItemDetail("items/x.md", "---\ntitle: t\n---\n\n**bold** and `code`\n\n- one\n- two\n");
    expect(d.bodyHtml).toContain("<strong>bold</strong>");
    expect(d.bodyHtml).toContain("<code>code</code>");
    expect(d.bodyHtml).toContain("<li>one</li>");
  });

  test("a file with no frontmatter is a defect, not an empty-frontmatter item", () => {
    // parseItemFileText's standing contract: every item file has frontmatter, and one
    // without it is surfaced rather than rendered as a blank-metadata card
    expect(() => buildItemDetail("items/bare.md", "Just a body.\n")).toThrow(/no frontmatter/);
  });
});

// Agents routinely paste material they did not author into item bodies. Raw HTML would
// otherwise run as script in the operator's Ledger session.
describe("buildItemDetail  -  the body is not an HTML injection surface", () => {
  function render(body: string): string {
    return buildItemDetail("items/hostile.md", `---\ntitle: t\n---\n\n${body}\n`).bodyHtml;
  }

  test("a script tag is rendered as text, never as an element", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an event-handler attribute never reaches the document", () => {
    const html = render('<img src=x onerror="alert(1)">');
    // the escaped source stays visible as text  -  what must never happen is an
    // actual element carrying the handler, so assert on the markup, not the words
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
  });

  test("an inline raw HTML span is escaped too, not just block-level HTML", () => {
    const html = render('text with <b onmouseover="alert(1)">inline</b> markup');
    expect(html).not.toMatch(/<b\s/i);
    expect(html).toContain("&lt;b onmouseover=");
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
  });

  test("a javascript: link loses its href and degrades to plain text", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
  });

  test("a data: link is dropped the same way", () => {
    const html = render("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("data:text/html");
  });

  test("a markdown image is not fetched  -  the alt text survives as text", () => {
    const html = render("![alt](https://tracker.example.com/pixel.png)");
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("alt");
  });

  test("an ordinary external link stays a link and opens in a new tab", () => {
    const html = render("[docs](https://example.com/page)");
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("a repo-relative link to another item still works", () => {
    const html = render("see [the spec](docs/specs/thing.md)");
    expect(html).toContain('href="docs/specs/thing.md"');
    expect(html).toContain('target="_blank"');
  });

  test("HTML inside a fenced code block renders as visible code, not markup", () => {
    const html = render("```\n<script>alert(1)</script>\n```");
    expect(html).toContain("<pre>");
    expect(html).not.toContain("<script>");
  });
});
