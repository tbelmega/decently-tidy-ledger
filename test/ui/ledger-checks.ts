// Browser assertions for the Ledger served at `/`.
import type { Checks, Page } from "./harness.ts";
import { buildPresenceFixture } from "../test-presence.ts";

/** Pinned so assertions do not depend on Chrome's default headless window, which is
 * narrow enough that one third of it falls below the drawer's own 380px floor. */
const BASE_VIEWPORT = { width: 1600, height: 1000 };

/** Serve a fixed fleet from `/api/workers`, so every rail assertion below is about the
 * rail rather than about what the machines happened to be doing.
 *
 * A live snapshot cannot do this job. A configured provider rewrites it as the fleet
 * changes, and it is absent entirely on a fresh clone or wherever no provider is
 * registered  -  a check that passes only while some machine happens to be asleep is not a
 * check.
 *
 * The stub survives the later fetch overrides in runFleetFailureChecks: each of those
 * captures the current `window.fetch` and restores it, so "recovered" recovers to this.
 * Reinstall it after any navigate  -  a page load discards it. */
async function stubFleet(page: Page, sweptMinutesAgo: number): Promise<void> {
  const now = new Date();
  const payload = {
    readAt: now.toISOString(),
    sweptAt: new Date(now.getTime() - sweptMinutesAgo * 60_000).toISOString(),
    sweptFrom: "worker-a",
    source: "live",
    workers: buildPresenceFixture(now),
  };
  await page.evaluate(`(async () => {
    const original = window.fetch;
    const body = ${JSON.stringify(JSON.stringify(payload))};
    window.fetch = (u, o) => String(u).includes('/api/workers')
      ? Promise.resolve(new Response(body, { status: 200,
          headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    await fetchFleet();
  })()`);
}

/** The drawer width persists to localStorage by design, so a previous run would
 * otherwise contaminate the "defaults to ~1/3" assertion  -  a real false failure. */
async function resetPersistedState(page: Page, url: string): Promise<void> {
  await page.evaluate(`localStorage.removeItem('kb.drawerWidth')`);
  await page.navigate(url);
}

export async function runLedgerChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  const url = `${baseUrl}/`;
  await page.setViewport(BASE_VIEWPORT);
  await page.navigate(url);
  await resetPersistedState(page, url);
  await stubFleet(page, 5);

  // ---- the drawer must be invisible on load, by computed style ----
  // an authored `display` beats the UA rule behind [hidden], so `.hidden === true` alone
  // once passed while the panel sat on screen
  const onLoad = JSON.parse(await page.evaluate(`JSON.stringify({
    hiddenProp: document.getElementById('drawer-overlay').hidden,
    display: getComputedStyle(document.getElementById('drawer-overlay')).display,
  })`));
  checks.check(
    "drawer is not rendered on load (computed display, not just .hidden)",
    onLoad.hiddenProp && onLoad.display === "none", onLoad,
  );

  // ---- structure ----
  const structure = JSON.parse(await page.evaluate(`JSON.stringify({
    sections: [...document.querySelectorAll('.rail-sec')].map(s => s.id),
    legendInsideProjects: !!document.querySelector('#sec-projects .legend'),
    legendIsPeer: !!document.querySelector('.rail > .legend'),
    workerRows: document.querySelectorAll('.worker-row').length,
    summary: document.getElementById('workers-summary').textContent,
    cards: document.querySelectorAll('.card').length,
    cardRole: document.querySelector('.card')?.getAttribute('role'),
    openBtnTag: document.querySelector('.card .card-open')?.tagName,
    fileInsideAriaButton: !!document.querySelector('[role="button"] .card-file'),
    fileIcons: document.querySelectorAll('.card-file').length,
    fileHref: document.querySelector('.card-file')?.getAttribute('href'),
    bodyScrollsX: document.body.scrollWidth > document.body.clientWidth,
  })`));
  checks.check("Projects and Workers are the two rail sections",
    JSON.stringify(structure.sections) === JSON.stringify(["sec-projects", "sec-workers"]),
    structure.sections);
  checks.check("the legend sits inside Projects, not as a peer of Workers",
    structure.legendInsideProjects && !structure.legendIsPeer);
  checks.check("worker rows render", structure.workerRows > 0, structure.workerRows);
  checks.check("the card's control is a real button and the file link is not its descendant",
    structure.cardRole === null && structure.openBtnTag === "BUTTON" && !structure.fileInsideAriaButton,
    structure);
  checks.check("every card carries a file icon",
    structure.fileIcons === structure.cards, { icons: structure.fileIcons, cards: structure.cards });
  checks.check("the file icon uses the local repo route",
    /^\/(items|for-delivery|archive)\//.test(String(structure.fileHref)), structure.fileHref);

  // the header states readiness and the age of the reading, never a bare liveness count
  checks.check("the rail header reads N ready and when the fleet was swept",
    /^\d+ ready · swept /.test(String(structure.summary)), structure.summary);

  // ---- collapse ----
  const collapse = JSON.parse(await page.evaluate(`(() => {
    const sec = document.getElementById('sec-workers');
    const head = sec.querySelector('.sec-head');
    const before = sec.getBoundingClientRect().height;
    head.click();
    const after = sec.getBoundingClientRect().height;
    const collapsed = head.getAttribute('aria-expanded');
    head.click();
    return JSON.stringify({ before, after, collapsed, reopened: head.getAttribute('aria-expanded') });
  })()`));
  checks.check("collapsing Workers shrinks it and reports aria-expanded=false",
    collapse.after < collapse.before && collapse.collapsed === "false", collapse);
  checks.check("re-expanding restores aria-expanded=true", collapse.reopened === "true", collapse);

  // ---- shrink order in a short rail ----
  await page.setViewport({ width: 1400, height: 560 });
  const shrink = JSON.parse(await page.evaluate(`(() => {
    const projects = document.getElementById('sec-projects').getBoundingClientRect();
    const workers = document.getElementById('sec-workers').getBoundingClientRect();
    const footer = document.querySelector('.rail-foot').getBoundingClientRect();
    return JSON.stringify({
      projectsHeight: projects.height,
      workersOverlapsFooter: workers.bottom - footer.top,
      footerBottom: footer.bottom, viewport: window.innerHeight,
    });
  })()`));
  checks.check("Projects keeps its floor when the rail is short",
    shrink.projectsHeight >= 222, shrink);
  checks.check("Workers never overlaps the pinned footer",
    shrink.workersOverlapsFooter <= 1, shrink);
  checks.check("the footer stays inside the viewport",
    shrink.footerBottom <= shrink.viewport + 1, shrink);
  await page.setViewport(BASE_VIEWPORT);

  // ---- worker chips filter the board ----
  const chip = JSON.parse(await page.evaluate(`(() => {
    const chip = document.querySelector('.worker-chip');
    if (!chip) return JSON.stringify({ skipped: true });
    chip.click();
    const active = document.querySelector('.worker-chip.active');
    return JSON.stringify({
      project: chip.dataset.project,
      title: document.getElementById('scope-title').textContent,
      active: active?.dataset.project, pressed: active?.getAttribute('aria-pressed'),
      railSelected: document.querySelector('.rail-row.selected')?.dataset.project,
    });
  })()`));
  if (chip.skipped) {
    // recorded rather than dropped: a check that leaves no line behind is indistinguishable
    // from one that never existed, and the reader cannot tell coverage from silence
    checks.skip("a worker's project chip filters the board", "no worker chip on screen", chip);
    checks.skip("the active chip is accented and aria-pressed", "no worker chip on screen", chip);
    checks.skip("the project rail follows the chip selection", "no worker chip on screen", chip);
  } else {
    checks.check("a worker's project chip filters the board", chip.title === chip.project, chip);
    checks.check("the active chip is accented and aria-pressed",
      chip.active === chip.project && chip.pressed === "true", chip);
    checks.check("the project rail follows the chip selection",
      chip.railSelected === chip.project, chip);
  }
  await page.evaluate(`document.querySelector('.rail-row.all').click()`);

  // ---- the actor tabs label what they are showing ----
  // The scope note's phrase comes from a chained ternary whose last branch is a fallback
  // rather than a test, so it reports the agent phrase for any value it does not
  // recognise. Nothing else fails when the tab's `data-actor` and that ternary disagree:
  // the cards still filter correctly and only the sentence above them lies. Assert the
  // phrase against the tab that produced it, per tab, or a rename can pass every check.
  interface ActorTab { actor: "all" | "owner" | "agent"; label: string; note: string; cards: number }
  const actorTabs: ActorTab[] = JSON.parse(await page.evaluate(`(() => {
    const seen = [];
    for (const tab of document.querySelectorAll('#actor-tabs > button')) {
      tab.click();
      seen.push({
        actor: tab.dataset.actor,
        label: tab.textContent.trim(),
        note: document.getElementById('scope-note').textContent,
        cards: document.querySelectorAll('.card').length,
      });
    }
    document.querySelector('#actor-tabs > button[data-actor="all"]').click();
    return JSON.stringify(seen);
  })()`));
  const phraseFor: Record<ActorTab["actor"], string> =
    { all: "everything", owner: "needs you", agent: "ready for an agent" };
  for (const tab of actorTabs) {
    checks.check(`the ${tab.actor} tab's scope note says "${phraseFor[tab.actor]}"`,
      tab.note.includes(` · ${phraseFor[tab.actor]} · `), tab);
    checks.check(`the ${tab.actor} tab's scope note counts the cards it rendered`,
      tab.note.startsWith(`${tab.cards} open items · `), tab);
  }
  // the fixtures carry both kinds, so neither tab can pass by rendering nothing
  const cardsOn = (actor: ActorTab["actor"]): number =>
    actorTabs.find((tab) => tab.actor === actor)?.cards ?? -1;
  checks.check("each actor tab has cards to label, and together they account for All",
    cardsOn("owner") > 0 && cardsOn("agent") > 0 &&
    cardsOn("owner") + cardsOn("agent") === cardsOn("all"),
    actorTabs);

  // ---- the file icon does not open the drawer ----
  const iconClick = JSON.parse(await page.evaluate(`(() => {
    document.querySelector('.card-file').click();
    const o = document.getElementById('drawer-overlay');
    return JSON.stringify({ closed: o.hidden && getComputedStyle(o).display === 'none' });
  })()`));
  checks.check("clicking the file icon does not open the drawer", iconClick.closed, iconClick);

  // ---- opening the drawer ----
  const opened = JSON.parse(await page.evaluate(`(async () => {
    const opener = document.querySelector('.card .card-open');
    opener.focus();
    opener.click();
    await new Promise(r => setTimeout(r, 900));
    const drawer = document.getElementById('drawer');
    return JSON.stringify({
      visible: !document.getElementById('drawer-overlay').hidden,
      role: drawer.getAttribute('role'), modal: drawer.getAttribute('aria-modal'),
      chips: document.querySelectorAll('#drawer-chips .chip').length,
      factLabels: [...document.querySelectorAll('.facts dt')].map(x => x.textContent),
      hasBody: !!document.querySelector('.md-body')?.innerHTML.length,
      frontmatterShown: !!document.querySelector('.frontmatter'),
      focusInside: drawer.contains(document.activeElement),
      width: Math.round(drawer.getBoundingClientRect().width),
      expected: Math.round(Math.min(Math.max(window.innerWidth / 3, 380), window.innerWidth * 0.88)),
      openMd: document.getElementById('drawer-open-md').getAttribute('href'),
    });
  })()`));
  checks.check("clicking a card opens the drawer", opened.visible, opened.visible);
  checks.check("the drawer is a labelled modal dialog",
    opened.role === "dialog" && opened.modal === "true", opened);
  checks.check("the header carries lead, project and state chips", opened.chips === 3, opened.chips);
  checks.check("the facts panel lists the always-on rows",
    ["Next step", "Next actor", "Autonomy", "Owner"].every((l) => opened.factLabels.includes(l)),
    opened.factLabels);
  checks.check("the markdown body renders", opened.hasBody);
  checks.check("the frontmatter block is off on first open", !opened.frontmatterShown);
  checks.check("focus moves into the drawer on open", opened.focusInside);
  // a third of the viewport, clamped to the drawer's own bounds  -  on a narrow window
  // the 380px floor legitimately wins, and asserting the raw third would be wrong
  checks.check("the drawer defaults to about a third of the viewport",
    Math.abs(opened.width - opened.expected) <= 2, { width: opened.width, expected: opened.expected });
  checks.check("Open .md is never left on href=#",
    opened.openMd && opened.openMd !== "#", opened.openMd);

  const refreshedFocus = JSON.parse(await page.evaluate(`(() => {
    const slug = drawerSlug;
    render();
    closeDrawer();
    const current = [...document.querySelectorAll('.card')]
      .find((card) => card.dataset.slug === slug)?.querySelector('.card-open');
    return JSON.stringify({
      slug,
      activeIsCurrentCard: document.activeElement === current,
      activeIsConnected: document.body.contains(document.activeElement),
    });
  })()`));
  checks.check("closing after a refresh restores focus to the current card",
    refreshedFocus.activeIsCurrentCard && refreshedFocus.activeIsConnected, refreshedFocus);
  await page.evaluate(`openDrawer(${JSON.stringify(refreshedFocus.slug)})`);

  // ---- rendered markdown is inert and escapes the board tab safely ----
  const links = JSON.parse(await page.evaluate(`(() => {
    const as = [...document.querySelectorAll('.md-body a')];
    return JSON.stringify({
      count: as.length,
      allBlank: as.every(a => a.getAttribute('target') === '_blank'),
      allNoopener: as.every(a => (a.getAttribute('rel') || '').includes('noopener')),
      anyScript: !!document.querySelector('.md-body script'),
      anyJsHref: as.some(a => (a.getAttribute('href') || '').startsWith('javascript:')),
      anyImg: !!document.querySelector('.md-body img'),
    });
  })()`));
  checks.check("no script element or javascript: href survives into the drawer",
    !links.anyScript && !links.anyJsHref, links);
  checks.check("no markdown image is fetched from an item body", !links.anyImg, links);
  if (links.count > 0) {
    checks.check("markdown links open in a new tab with noopener",
      links.allBlank && links.allNoopener, links);
  }

  // ---- frontmatter toggle ----
  const frontmatter = JSON.parse(await page.evaluate(`(() => {
    document.getElementById('drawer-frontmatter').click();
    const block = document.querySelector('.frontmatter');
    const raw = block ? block.textContent : '';
    return JSON.stringify({
      shown: !!block,
      pressed: document.getElementById('drawer-frontmatter').getAttribute('aria-pressed'),
      looksLikeYaml: raw.includes('title:') && raw.includes('state:'),
      hasFences: raw.includes('---'),
    });
  })()`));
  checks.check("the frontmatter toggle renders raw YAML",
    frontmatter.shown && frontmatter.looksLikeYaml && frontmatter.pressed === "true", frontmatter);
  checks.check("the frontmatter is unparsed and unfenced", !frontmatter.hasFences, frontmatter);

  // ---- resize, clamping and persistence ----
  const resize = JSON.parse(await page.evaluate(`(() => {
    const drawer = document.getElementById('drawer');
    const strip = document.getElementById('drawer-resize');
    strip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }));
    const target = Math.round(window.innerWidth * 0.5);
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth - target }));
    const dragged = drawer.getBoundingClientRect().width;
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth - 100 }));
    const atFloor = drawer.getBoundingClientRect().width;
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1 }));
    const atCeiling = drawer.getBoundingClientRect().width;
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return JSON.stringify({ dragged, target, atFloor, atCeiling,
      ceiling: window.innerWidth * 0.88, stored: localStorage.getItem('kb.drawerWidth') });
  })()`));
  checks.check("dragging the strip resizes the drawer",
    Math.abs(resize.dragged - resize.target) <= 2, resize);
  checks.check("the drag clamps at the 380px floor",
    Math.abs(resize.atFloor - 380) <= 1, resize);
  checks.check("the drag clamps at the 88vw ceiling",
    Math.abs(resize.atCeiling - resize.ceiling) <= 1, resize);
  checks.check("the dragged width persists to kb.drawerWidth",
    Math.abs(Number(resize.stored) - resize.atCeiling) <= 2, resize);

  // ---- the separator reports a valid range, including where the bounds would cross ----
  await page.setViewport({ width: 400, height: 800 });
  const narrow = JSON.parse(await page.evaluate(`(() => {
    const strip = document.getElementById('drawer-resize');
    return JSON.stringify({
      min: Number(strip.getAttribute('aria-valuemin')),
      max: Number(strip.getAttribute('aria-valuemax')),
      now: Number(strip.getAttribute('aria-valuenow')),
      rendered: Math.round(document.getElementById('drawer').getBoundingClientRect().width),
    });
  })()`));
  checks.check("the ARIA range never inverts on a narrow viewport", narrow.min <= narrow.max, narrow);
  checks.check("aria-valuenow matches the rendered width after a resize",
    narrow.now === narrow.rendered, narrow);
  checks.check("aria-valuenow stays inside the announced range",
    narrow.now >= narrow.min && narrow.now <= narrow.max, narrow);
  await page.setViewport(BASE_VIEWPORT);

  // ---- closing ----
  const closing = JSON.parse(await page.evaluate(`(() => {
    const o = document.getElementById('drawer-overlay');
    const gone = () => o.hidden && getComputedStyle(o).display === 'none';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const afterEsc = gone();
    document.querySelector('.card .card-open').click();
    document.getElementById('drawer-scrim').click();
    return JSON.stringify({ afterEsc, afterScrim: gone() });
  })()`));
  checks.check("Esc closes the drawer", closing.afterEsc, closing);
  checks.check("clicking the scrim closes the drawer", closing.afterScrim, closing);

  // ---- the width survives a reload ----
  await page.navigate(url);
  const restored = JSON.parse(await page.evaluate(`(async () => {
    document.querySelector('.card .card-open').click();
    await new Promise(r => setTimeout(r, 700));
    return JSON.stringify({
      width: Math.round(document.getElementById('drawer').getBoundingClientRect().width),
      stored: Number(localStorage.getItem('kb.drawerWidth')),
    });
  })()`));
  checks.check("the drawer width is restored after a reload",
    Math.abs(restored.width - restored.stored) <= 2, restored);

  // ---- a failed item load offers a way out ----
  const failedItem = JSON.parse(await page.evaluate(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await openDrawer('no-such-item-anywhere');
    await new Promise(r => setTimeout(r, 700));
    const note = document.querySelector('.drawer-note');
    return JSON.stringify({
      shown: !!note,
      hasFallbackLink: !!note && !!note.querySelector('a[href^="/items/"]'),
      openMd: document.getElementById('drawer-open-md').getAttribute('href'),
    });
  })()`));
  checks.check("a failed item load explains itself and links out",
    failedItem.shown && failedItem.hasFallbackLink, failedItem);
  checks.check("Open .md points somewhere real even when the load failed",
    failedItem.openMd && failedItem.openMd !== "#", failedItem);

  // ---- the local fallback respects the card's own folder ----
  // driven with synthetic cards rather than whatever happens to be on the board: a real
  // for-delivery card can disappear as items move, and the assertion would then silently
  // stop covering the case it exists for
  const fallback = JSON.parse(await page.evaluate(`(() => JSON.stringify({
    forDelivery: sourceUrl({ path: 'for-delivery/sample-slug.md', slug: 'sample-slug' }, 'sample-slug'),
    item: sourceUrl({ path: 'items/sample-slug.md', slug: 'sample-slug' }, 'sample-slug'),
    archived: sourceUrl({ path: 'archive/sample-slug.md', slug: 'sample-slug' }, 'sample-slug'),
    noCard: sourceUrl(null, 'orphan-slug'),
  }))()`));
  checks.check("the fallback for a for-delivery card points at for-delivery/",
    fallback.forDelivery === "/for-delivery/sample-slug.md", fallback);
  checks.check("the fallback for an items card points at items/",
    fallback.item === "/items/sample-slug.md", fallback);
  checks.check("the fallback for an archived card points at archive/",
    fallback.archived === "/archive/sample-slug.md", fallback);
  checks.check("with no card at all the fallback still resolves to items/",
    fallback.noCard === "/items/orphan-slug.md", fallback);

  // ---- the page itself never scrolls sideways on a wide screen ----
  await page.setViewport({ width: 2000, height: 1000 });
  const wide = JSON.parse(await page.evaluate(`JSON.stringify({
    body: document.body.scrollWidth > document.body.clientWidth,
    doc: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  })`));
  checks.check("no horizontal page scroll at 2000px", !wide.body && !wide.doc, wide);
  await page.setViewport(BASE_VIEWPORT);
}

/** The rail's readiness dots and its staleness rule, driven from a fixed fleet.
 *
 * These are the derivations the client mirrors from workers.ts, and they only
 * exist in the browser copy  -  the unit tests cover the server copy, so a divergence between
 * the two would otherwise ship silently. */
export async function runFleetReadinessChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);
  await stubFleet(page, 5);

  const rail = JSON.parse(await page.evaluate(`JSON.stringify({
    ready: document.querySelectorAll('.worker-dot.ready').length,
    held: document.querySelectorAll('.worker-dot.held').length,
    unreachable: document.querySelectorAll('.worker-dot.unreachable').length,
    summary: document.getElementById('workers-summary').textContent,
    dimmed: document.getElementById('worker-list').classList.contains('stale'),
    neverSeen: [...document.querySelectorAll('.worker-row')]
      .some(r => r.querySelector('.worker-when').textContent === 'never seen'),
    heldReason: [...document.querySelectorAll('.worker-row.held')]
      .map(r => r.getAttribute('title')).join(' | '),
    readyReason: (document.querySelector('.worker-row.ready') || {}).title || '',
    dotLabels: [...document.querySelectorAll('.worker-dot')]
      .map(d => d.getAttribute('aria-label') || ''),
  })`));
  // green is reachable AND cleared AND capable; the fixture holds one host held for each
  // of the three reasons the rail can report
  checks.check("green counts only hosts that could take a session",
    rail.ready === 3 && rail.held === 2 && rail.unreachable === 2, rail);
  checks.check("the header count matches the green dots",
    String(rail.summary).startsWith(rail.ready + " ready · swept "), rail);
  checks.check("a fresh sweep does not dim the rail", rail.dimmed === false, rail);
  // a host the sweep has never reached must not borrow the sweep's own timestamp
  checks.check("a host never reached reads 'never seen', not a fabricated age",
    rail.neverSeen === true, rail);
  // "held" alone would send an operator to the roster to find out why
  checks.check("an amber row says which condition it fails",
    rail.heldReason.includes("toolchain not installed") &&
    rail.heldReason.includes("deliberately not a dispatch target"), rail.heldReason);
  checks.check("a green row says it could take a session",
    rail.readyReason.includes("could take a session"), rail.readyReason);
  // A title is reachable by hovering a pointer and by nothing else, and the row is a plain
  // div that cannot be focused. The dot carries role="img", so its label is what is actually
  // announced  -  and announcing the bare word "held" tells an operator nothing they can act on.
  checks.check("the announced dot label carries the reason, not just the colour",
    rail.dotLabels.length > 0 &&
    rail.dotLabels.every((l: string) => l.includes(" · ")) &&
    rail.dotLabels.some((l: string) => l.includes("toolchain not installed")), rail.dotLabels);

  // Staleness belongs to the SNAPSHOT, not to a host: past six hours the whole picture is
  // old, so the whole rail dims rather than individual rows.
  await stubFleet(page, 7 * 60);
  const stale = JSON.parse(await page.evaluate(`JSON.stringify({
    summary: document.getElementById('workers-summary').textContent,
    dimmed: document.getElementById('worker-list').classList.contains('stale'),
    rows: document.querySelectorAll('.worker-row').length,
  })`));
  checks.check("a sweep older than six hours dims the rail and says stale",
    stale.dimmed === true && String(stale.summary).endsWith("  -  stale"), stale);
  checks.check("a stale sweep still shows the fleet rather than hiding it",
    stale.rows > 0, stale);

  // The other end of the same rule, and the one only the browser copy can be caught on: a
  // reading dated further ahead than clock skew explains cannot be placed in time either.
  // Clamping it to "just now" would make a months-old fleet look freshly swept and hold the
  // six-hour rule open until real time caught up. The unit tests cover the server copy
  // of this branch, and the browser copy is a separate implementation.
  await stubFleet(page, -90);
  const ahead = JSON.parse(await page.evaluate(`JSON.stringify({
    summary: document.getElementById('workers-summary').textContent,
    dimmed: document.getElementById('worker-list').classList.contains('stale'),
  })`));
  checks.check("a sweep dated well into the future is stale, not fresh",
    ahead.dimmed === true && String(ahead.summary).endsWith("  -  stale"), ahead);
}

/** The fleet rail must never present a failed read as an empty fleet  -  the same
 * NOT-CHECKED-vs-clear rule the outbox keeps. */
export async function runFleetFailureChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);
  await stubFleet(page, 5);

  const good = JSON.parse(await page.evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.worker-row').length,
    summary: document.getElementById('workers-summary').textContent,
  })`));
  checks.check("a successful read renders worker rows", good.rows > 0, good);

  const netFail = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/workers')
      ? Promise.reject(new Error('boom')) : original(u, o);
    await fetchFleet();
    window.fetch = original;
    const list = document.getElementById('worker-list');
    return JSON.stringify({
      summary: document.getElementById('workers-summary').textContent,
      rows: document.querySelectorAll('.worker-row').length,
      note: (list.querySelector('.worker-note') || {}).textContent || '',
      claimsEmpty: list.textContent.includes('no workers reported'),
    });
  })()`));
  checks.check("a network failure is never rendered as 'no workers reported'",
    !netFail.claimsEmpty, netFail);
  checks.check("a network failure reports 'not checked' rather than a count",
    netFail.summary === "not checked", netFail);
  checks.check("a network failure keeps the last known rows", netFail.rows > 0, netFail);
  checks.check("a network failure explains itself in a banner",
    netFail.note.includes("could not read the fleet"), netFail);

  const httpFail = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/workers')
      ? Promise.resolve(new Response('{"oops":true}', { status: 500,
          headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    await fetchFleet();
    window.fetch = original;
    const list = document.getElementById('worker-list');
    return JSON.stringify({
      summary: document.getElementById('workers-summary').textContent,
      claimsEmpty: list.textContent.includes('no workers reported'),
      note: (list.querySelector('.worker-note') || {}).textContent || '',
    });
  })()`));
  checks.check("a 500 carrying JSON is a failure, not an empty fleet",
    !httpFail.claimsEmpty && httpFail.summary === "not checked", httpFail);
  checks.check("the HTTP status is named in the banner",
    httpFail.note.includes("HTTP 500"), httpFail);

  // The endpoint says WHY it could not answer  -  which file it could not read, or which field
  // of it was wrong. Discarding that left an operator unable to tell an absent snapshot from
  // a malformed one, which are repaired differently.
  const diagnosed = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/workers')
      ? Promise.resolve(new Response(
          '{"error":"/home/x/runbook/fleet-presence.json: host worker-b was reached but has no lastSeenAt"}',
          { status: 503, headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    await fetchFleet();
    window.fetch = original;
    const list = document.getElementById('worker-list');
    return JSON.stringify({ note: (list.querySelector('.worker-note') || {}).textContent || '' });
  })()`));
  checks.check("a 503 keeps the endpoint's explanation, not just the status code",
    diagnosed.note.includes("no lastSeenAt") && diagnosed.note.includes("HTTP 503"), diagnosed);

  const recovered = JSON.parse(await page.evaluate(`(async () => {
    await fetchFleet();
    return JSON.stringify({
      summary: document.getElementById('workers-summary').textContent,
      stillBannered: !!document.querySelector('.worker-note:not(.mock)'),
    });
  })()`));
  checks.check("a later successful read clears the failure state",
    !recovered.stillBannered, recovered);
}
