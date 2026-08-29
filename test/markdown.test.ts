import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/markdown.ts";

// slug → the path the item actually lives at; items move between the three folders
const KNOWN = new Map([
  ["alpha", "items/alpha.md"],
  ["beta", "for-delivery/beta.md"],
  ["gamma", "archive/gamma.md"],
]);

describe("[[wikilink]]", () => {
  test("resolves a known slug to an item link", () => {
    const html = renderMarkdown("superseded by [[alpha]]", KNOWN);
    expect(html).toContain('href="items/alpha.md"');
    expect(html).toContain(">alpha<");
  });

  test("leaves an unknown slug as literal text rather than a dead link", () => {
    // entries reference items that were archived or never existed; a 404 is worse
    const html = renderMarkdown("see [[nope]]", KNOWN);
    expect(html).not.toContain("<a ");
    expect(html).toContain("[[nope]]");
  });

  test("with no known items, every wikilink stays literal", () => {
    // the correct degradation when the item payload could not be read
    expect(renderMarkdown("see [[alpha]]")).toContain("[[alpha]]");
  });

  test("resolves several in one paragraph", () => {
    const html = renderMarkdown("[[alpha]] then [[beta]]", KNOWN);
    expect(html).toContain('href="items/alpha.md"');
    expect(html).toContain('href="for-delivery/beta.md"');
  });

  test("links an item at the folder it actually lives in", () => {
    // an accepted item is in archive/, a verified one in for-delivery/; guessing an
    // items/ prefix 404s exactly when the entry is oldest
    expect(renderMarkdown("[[gamma]]", KNOWN)).toContain('href="archive/gamma.md"');
    expect(renderMarkdown("[[beta]]", KNOWN)).toContain('href="for-delivery/beta.md"');
  });

  test("goes through the same hardening as any other link", () => {
    expect(renderMarkdown("[[alpha]]", KNOWN)).toContain('rel="noopener noreferrer"');
  });
});

describe("the hardening the outbox inherits", () => {
  test("raw HTML becomes visible text, never markup", () => {
    const html = renderMarkdown("<script>alert(1)</script>", KNOWN);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("a javascript: link loses its href and keeps its text", () => {
    const html = renderMarkdown("[click](javascript:alert(1))", KNOWN);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  test("an image is not fetched  -  the alt text survives, the request does not", () => {
    const html = renderMarkdown("![alt](https://example.com/x.png)", KNOWN);
    expect(html).not.toContain("<img");
    expect(html).toContain("alt");
  });

  test("an ordinary link opens away from the board tab", () => {
    const html = renderMarkdown("[docs](https://example.com)", KNOWN);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("nested lists already work  -  marked handles them, nothing was rebuilt", () => {
    const html = renderMarkdown("- one\n  - nested\n- two", KNOWN);
    expect(html).toContain("<ul>");
    expect((html.match(/<ul>/g) ?? []).length).toBeGreaterThan(1);
  });
});
