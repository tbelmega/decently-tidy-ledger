// Browser assertions for the outbox regions. The derivations are unit-tested; what
// lives here is everything only a real browser can answer  -  stacking, focus, whether a
// tier-2 control can hide a tier-1 signal, and whether the badge's click reaches the
// card underneath it.
import type { Checks, Page } from "./harness.ts";

export async function runOutboxChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);

  // ---- the sidebar row ----
  const row = JSON.parse(await page.evaluate(`JSON.stringify({
    present: !!document.getElementById('outbox-row'),
    summary: document.getElementById('outbox-summary').textContent,
    dotClass: document.getElementById('outbox-dot').className,
    aboveProjects: document.getElementById('outbox-row').compareDocumentPosition(
      document.getElementById('sec-projects')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false,
  })`));
  checks.check("the outbox row is pinned above Projects", row.present && row.aboveProjects, row);
  checks.check("it reports a count rather than staying on the loading placeholder",
    row.summary !== "…" && row.summary.length > 0, row);
  // the fixture's one open entry is a `question`, which DCL maps to kind `ask`, so the hue
  // is required rather than merely permitted: a pattern that also admitted the bare
  // `outbox-dot` class would pass if urgency colouring disappeared entirely
  checks.check("the dot's hue follows the most urgent open kind",
    /^outbox-dot ask$/.test(row.dotClass), row);

  // ---- the panel ----
  await page.evaluate(`document.getElementById('outbox-row').click()`);
  const panel = JSON.parse(await page.evaluate(`JSON.stringify({
    visible: !document.getElementById('outbox-overlay').hidden,
    display: getComputedStyle(document.getElementById('outbox-overlay')).display,
    entries: document.querySelectorAll('.outbox-entry').length,
    zIndex: getComputedStyle(document.querySelector('.outbox-overlay')).zIndex,
    drawerZ: getComputedStyle(document.querySelector('.drawer-overlay')).zIndex,
    anomalies: document.querySelectorAll('.outbox-anomaly').length,
    structural: document.querySelectorAll('.outbox-anomaly:not([data-kind="retired-type"])').length,
    claimsClear: /is clear/.test(document.getElementById('outbox-body').textContent),
  })`));
  checks.check("the panel opens", panel.visible && panel.display !== "none", panel);
  // An empty OUTBOX.md is a legitimate state - both queues are meant to trend toward it - so
  // this asserts the disjunction rather than a count. What must hold either way: entries are
  // listed, or the panel says plainly that the outbox is clear. (The distinct failure case, a
  // failed read rendered as "clear", is asserted separately in runOutboxFailureChecks.)
  checks.check("it lists the entries, or says the outbox is clear",
    panel.entries > 0 || panel.claimsClear === true, panel);

  // ...and prove the second branch, which the fixture's own entries can never reach: the
  // assertion above always short-circuits on the first, so a regression in the clear-state
  // render would ship green. The one empty payload elsewhere in this suite carries an
  // anomaly on purpose, so it does not cover the clean case.
  const empty = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).split('?')[0].endsWith('/api/outbox')
      ? Promise.resolve(new Response(JSON.stringify({ readAt: 'empty', entries: [], anomalies: [] }),
          { headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    await fetchOutbox();
    const seen = {
      summary: document.getElementById('outbox-summary').textContent,
      body: document.getElementById('outbox-body').textContent,
      dotClass: document.getElementById('outbox-dot').className,
    };
    window.fetch = original;
    await fetchOutbox();
    return JSON.stringify({ ...seen, claimsClear: /is clear/.test(seen.body) });
  })()`));
  checks.check("a genuinely empty outbox renders the clear state", empty.claimsClear === true, empty);
  checks.check("and the row says clear rather than 'not checked'",
    empty.summary === "clear", empty);
  checks.check("and the dot carries no kind when nothing is open",
    empty.dotClass === "outbox-dot", empty);
  // an author `display` beats the UA rule behind [hidden]  -  the drawer was once
  // "hidden" and on screen at the same time, which is why this is asserted by style
  checks.check("the panel sits below the item drawer so the drawer can stack over it",
    Number(panel.zIndex) < Number(panel.drawerZ), panel);

  checks.check("the fixture OUTBOX.md raises no STRUCTURAL anomaly", panel.structural === 0, panel);

  // ---- notice vs ask: two hues, equal loudness ----
  const kinds = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const open = [...document.querySelectorAll('.outbox-entry:not(.answered)')];
    return {
      open: open.length,
      opacities: [...new Set(open.map((e) => getComputedStyle(e).opacity))],
      notes: [...new Set(open.map((e) => (e.querySelector('.entry-note') || {}).textContent))],
      accents: [...new Set(open.map((e) => getComputedStyle(e).borderLeftColor))],
    };
  })())`));
  // `every` on an empty list is vacuously true, so the two checks below would report PASS
  // while asserting nothing. The fixture ships an open entry; assert that it arrived
  // rather than letting an empty list quietly satisfy them.
  checks.check("the fixture outbox renders at least one open entry", kinds.open > 0, kinds);
  checks.check("every open entry is at full opacity, whatever its type",
    kinds.opacities.every((o: string) => Number(o) === 1), kinds);
  checks.check("each open entry states whether the agent acted or stopped",
    kinds.notes.every((n: string) => n === "acted  -  object to reverse" || n === "stopped  -  waiting on you"),
    kinds);

  // ---- Esc peels one layer ----
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  const afterEsc = JSON.parse(await page.evaluate(`JSON.stringify({
    outboxHidden: document.getElementById('outbox-overlay').hidden,
  })`));
  checks.check("Esc closes the panel", afterEsc.outboxHidden === true, afterEsc);

  // ---- the project rail must not hide a tier-1 signal ----
  const scoped = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const before = document.getElementById('outbox-summary').textContent;
    const nav = document.querySelector('#project-nav button:not([data-project="__all__"])');
    if (nav) nav.click();
    return { before, after: document.getElementById('outbox-summary').textContent };
  })())`));
  // selecting a project may narrow the panel, but the row must still show the global
  // total  -  "N of M open"  -  never silently drop to the filtered figure
  checks.check("selecting a project never hides the outbox row",
    scoped.after.length > 0 && scoped.after !== "…", scoped);
  checks.check("a scoped count still names the global total",
    !/^\\d+ open$/.test(scoped.after) || scoped.after === scoped.before, scoped);
}

/** The outbox must never present a failed read as an empty outbox  -  "not checked" and
 * "clear" are different answers and the UI may never blur them. */
export async function runOutboxFailureChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);

  const failed = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/outbox')
      ? Promise.resolve(new Response('boom', { status: 500 })) : original(u, o);
    await fetchOutbox();
    window.fetch = original;
    document.getElementById('outbox-row').click();
    const body = document.getElementById('outbox-body').textContent;
    return JSON.stringify({
      summary: document.getElementById('outbox-summary').textContent,
      dotClass: document.getElementById('outbox-dot').className,
      body,
      claimsClear: /is clear/.test(body),
    });
  })()`));
  checks.check("a failed read says 'not checked', not 'clear'",
    failed.summary === "not checked", failed);
  checks.check("it never renders the empty state on a failure", failed.claimsClear === false, failed);
  checks.check("the panel explains that this is not an empty outbox",
    /NOT\s+an empty outbox/i.test(failed.body), failed);
  checks.check("the dot goes quiet rather than pretending to a kind",
    failed.dotClass === "outbox-dot", failed);
}

/** Serve the outbox with one guaranteed OPEN entry, without writing `OUTBOX.md`.
 *
 * The fixture repo ships one open entry, so the checks below have something to act on.
 * They must not consume it: the answer route writes the file it is given, and a suite
 * that answers its own fixture passes once and then runs against a drained outbox.
 *
 * So stub `/api/outbox` with the payload the server actually returned, one answer
 * blanked: real shape, real ids, real server-rendered bodies, and nothing written. The
 * fetch stubs inside the individual checks capture and restore this one as their
 * `original`, so they compose. */
async function installOpenEntryFixture(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const real = await (await fetch('/api/outbox', { cache: 'no-store' })).json();
    // A fixture that stopped serving an answerable entry is a broken suite, not a reason to
    // skip: every check downstream drives the answer form. Fail here, where the cause is
    // legible, rather than on a null dereference twenty checks later.
    //
    // An entry with no '> A:' line parses as answerable: false and renders an explanation
    // instead of a form (ledger.html:915), so blanking one would leave it open but formless.
    const target = (real.entries || []).findIndex((e) => e.answerable !== false);
    if (target === -1) throw new Error('the fixture outbox serves no answerable entry');
    const patched = {
      ...real,
      entries: real.entries.map((e, i) =>
        (i === target ? { ...e, answer: '', answerable: true } : e)),
    };
    window.__uiRealFetch = window.fetch;
    window.fetch = (u, o) => String(u).split('?')[0].endsWith('/api/outbox')
      ? Promise.resolve(new Response(JSON.stringify(patched),
          { headers: { 'content-type': 'application/json' } }))
      : window.__uiRealFetch(u, o);
    await fetchOutbox();
  })()`);
}

/** Hand the page back its real fetch, so a later suite sees the unpatched outbox. */
async function removeOpenEntryFixture(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    if (window.__uiRealFetch) {
      window.fetch = window.__uiRealFetch;
      delete window.__uiRealFetch;
      await fetchOutbox();
    }
  })()`);
}

/** The answer block. Every check here stubs `fetch`: the server is running in exclusive
 * write mode, so a check that actually submitted would rewrite the fixture OUTBOX.md and
 * leave the next run without the open entry it depends on. */
export async function runOutboxAnswerChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);
  await page.evaluate(`document.getElementById('outbox-row').click()`);

  await installOpenEntryFixture(page);

  const form = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const open = document.querySelector('.outbox-entry:not(.answered)');
    const f = open && open.querySelector('.entry-answer-form');
    return {
      present: !!f,
      rows: f ? Number(f.querySelector('textarea').rows) : 0,
      hint: f ? f.querySelector('.hint').textContent : '',
      answered: document.querySelectorAll('.outbox-entry.answered .entry-answer-form').length,
    };
  })())`));
  checks.check("every open entry can be answered from the ledger", form.present, form);
  // three of the four real answers on file are a single letter in parentheses
  checks.check("the textarea is two rows, not an essay box", form.rows === 2, form);
  checks.check("the keyboard path is stated", /↵/.test(form.hint), form);
  checks.check("an answered entry offers no way to clear it back to empty",
    form.answered === 0, form);

  const conflict = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    // pretend an agent rewrote OUTBOX.md between the read and the write
    window.fetch = (u, o) => String(u).includes('/answer')
      ? Promise.resolve(new Response(JSON.stringify({ error: 'entry changed since it was loaded' }),
          { status: 409, headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    const id = Number(document.querySelector('.outbox-entry:not(.answered)').dataset.entry);
    await sendAnswer(id, 'my draft answer');
    window.fetch = original;
    const after = document.querySelector('[data-answer="' + id + '"]');
    return JSON.stringify({
      conflictShown: !!document.querySelector('.entry-conflict'),
      draftKept: after ? after.querySelector('textarea').value : '',
      text: (document.querySelector('.entry-conflict') || {}).textContent || '',
    });
  })()`));
  checks.check("a 409 is shown rather than swallowed", conflict.conflictShown, conflict);
  // the draft is the one thing the operator typed and the one thing we cannot recover
  checks.check("a 409 keeps the draft on screen", conflict.draftKept === "my draft answer", conflict);
  checks.check("the conflict says the draft survived", /draft/i.test(conflict.text), conflict);

  const offline = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).includes('/answer')
      ? Promise.reject(new Error('boom')) : original(u, o);
    const id = Number(document.querySelector('.outbox-entry:not(.answered)').dataset.entry);
    await sendAnswer(id, 'another draft');
    window.fetch = original;
    const after = document.querySelector('[data-answer="' + id + '"]');
    return JSON.stringify({
      text: (document.querySelector('.entry-conflict') || {}).textContent || '',
      draftKept: after ? after.querySelector('textarea').value : '',
    });
  })()`));
  // it may have reached the server and been applied before the connection broke;
  // claiming otherwise invites re-sending an answer that already landed
  checks.check("an unreachable server says the outcome is unknown, not that nothing happened",
    /UNKNOWN/.test(offline.text) && !/nothing was written/i.test(offline.text), offline);
  checks.check("and still keeps the draft", offline.draftKept === "another draft", offline);

  await removeOpenEntryFixture(page);
}

/** The two interaction defects a unit test cannot reach: whether the badge's click
 * beats the card's delegated handler, and whether Tab escapes an aria-modal dialog. */
export async function runOutboxInteractionChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);

  // both checks below need an open entry: one to render the card badge, one to render the
  // answer box the focus trap must contain
  await installOpenEntryFixture(page);

  const badge = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const b = document.querySelector('.outbox-badge');
    b.click();
    return {
      outboxOpen: !document.getElementById('outbox-overlay').hidden,
      // the card's own handler must NOT have fired underneath the badge
      drawerOpen: !document.getElementById('drawer-overlay').hidden,
    };
  })())`));
  checks.check("a card badge opens the outbox panel", badge.outboxOpen, badge);
  checks.check("and does not open the item drawer underneath it", badge.drawerOpen === false, badge);

  const trap = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    document.getElementById('outbox-row').click();
    const overlay = document.getElementById('outbox-overlay');
    const focusables = overlay.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const last = focusables[focusables.length - 1];
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    return {
      count: focusables.length,
      // Tab off the last focusable must wrap to the first, not walk into the rail
      stayedInside: overlay.contains(document.activeElement),
      includesTextarea: [...focusables].some((el) => el.tagName === 'TEXTAREA'),
    };
  })())`));
  checks.check("Tab does not escape the modal outbox", trap.stayedInside, trap);
  checks.check("the answer box is inside the focus trap", trap.includesTextarea, trap);

  await removeOpenEntryFixture(page);
}

/** The two remediations that live entirely in async ordering, plus focus restoration.
 * None is reachable from a unit test, and all three were shipped untested. */
export async function runOutboxOrderingChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);

  const race = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    let call = 0;
    // the FIRST request resolves last and with older content  -  without a sequence
    // guard it lands on top of the newer payload
    window.fetch = (u, o) => {
      if (!String(u).includes('/api/outbox')) return original(u, o);
      call += 1;
      const stale = call === 1;
      return new Promise((resolve) => setTimeout(() => resolve(
        new Response(JSON.stringify({ readAt: stale ? 'old' : 'new', entries: [], anomalies: [] }),
          { headers: { 'content-type': 'application/json' } })), stale ? 120 : 10));
    };
    const first = fetchOutbox();
    const second = fetchOutbox();
    await Promise.all([first, second]);
    window.fetch = original;
    return JSON.stringify({ readAt: outbox.readAt });
  })()`));
  checks.check("an older outbox refresh cannot overwrite a newer one",
    race.readAt === "new", race);

  const malformed = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/outbox')
      ? Promise.resolve(new Response(JSON.stringify({
          readAt: 'x', entries: [],
          anomalies: [{ kind: 'unparseable-heading', detail: 'broken heading' }],
        }), { headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    await fetchOutbox();
    window.fetch = original;
    document.getElementById('outbox-row').click();
    const body = document.getElementById('outbox-body').textContent;
    return JSON.stringify({ body, claimsClear: /is clear/.test(body) });
  })()`));
  // nothing parsed AND something was wrong is a broken file, not an empty one
  checks.check("a file where nothing parsed is not shown as a clear outbox",
    malformed.claimsClear === false, malformed);
  checks.check("and the anomalies are named on screen",
    /broken heading/.test(malformed.body), malformed);

  const focus = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const row = document.getElementById('outbox-row');
    row.focus();
    row.click();
    document.getElementById('outbox-close').click();
    return { restoredToRow: document.activeElement === row };
  })())`));
  checks.check("closing the panel returns focus to what opened it",
    focus.restoredToRow, focus);
}

/** Two answers submitted before the first resolves. The earlier, smaller payload must
 * not land last and roll the newer answer off the screen. */
export async function runOutboxSendRaceCheck(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);
  const race = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    const ENTRIES = [1, 2].map((id) => ({
      id, type: 'question', kind: 'ask', project: 'a', title: 't', body: '', bodyHtml: '',
      entryHash: 'h' + id, itemSlug: null, answer: null, answerable: true,
    }));
    let call = 0;
    window.fetch = (u, o) => {
      if (!String(u).includes('/answer')) return original(u, o);
      call += 1;
      const first = call === 1;
      // the FIRST send resolves LAST, and with the older one-entry snapshot
      // responses carry the entries, as the real endpoint does  -  a payload that
      // emptied the list would make the second send a no-op and prove nothing
      return new Promise((resolve) => setTimeout(() => resolve(new Response(
        JSON.stringify({ readAt: first ? 'older' : 'newer', entries: ENTRIES, anomalies: [] }),
        { headers: { 'content-type': 'application/json' } })), first ? 150 : 10));
    };
    outbox = { readAt: 'start', entries: ENTRIES, anomalies: [] };
    await Promise.all([sendAnswer(1, 'one'), sendAnswer(2, 'two')]);
    window.fetch = original;
    return JSON.stringify({ readAt: outbox.readAt });
  })()`));
  checks.check("a slow earlier answer cannot roll back a newer one",
    race.readAt === "newer", race);
}

/** The remediations from rounds 1 - 2 that shipped without interaction coverage
 *. Each asserts the fixed behaviour, not the fix. */
export async function runOutboxRegressionChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);

  // The loading check asserts the row keeps its last known COUNT rather than dropping to
  // "clear" mid-read, so it needs an open entry: against a clear outbox "clear" is the
  // honest last known value and the check could not tell the defect from the truth. The
  // hold-then-delegate stub below composes with this one - its `original` is the fixture,
  // so the read still hangs and still resolves.
  await installOpenEntryFixture(page);

  // ---- the loading state is not "clear" ----
  const loading = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    let release;
    const held = new Promise((r) => { release = r; });
    window.fetch = (u, o) => String(u).includes('/api/outbox')
      ? held.then(() => original(u, o)) : original(u, o);
    outboxStatus = 'loading';
    const pending = fetchOutbox();
    document.getElementById('outbox-row').click();
    const during = {
      summary: document.getElementById('outbox-summary').textContent,
      body: document.getElementById('outbox-body').textContent,
    };
    release();
    await pending;
    window.fetch = original;
    return JSON.stringify({ ...during, claimsClear: /is clear/.test(during.body) });
  })()`));
  checks.check("before the first read resolves, the outbox does not claim to be clear",
    loading.claimsClear === false, loading);
  // During a RE-fetch the row keeps its last known count, which is the same posture the
  // fleet rail takes and is better than blanking a number the operator was reading. What
  // must never happen is claiming the outbox is clear while the read is still in flight.
  checks.check("and the row never reports 'clear' while a read is in flight",
    loading.summary !== "clear", loading);
  checks.check("the panel says it is reading rather than showing an empty state",
    /reading OUTBOX\.md/.test(loading.body), loading);

  // ---- reverse Tab is contained too ----
  const reverse = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    document.getElementById('outbox-row').click();
    const overlay = document.getElementById('outbox-overlay');
    const focusables = overlay.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    focusables[0].focus();
    // shift+Tab off the FIRST focusable must wrap to the last, not step into the rail
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    const inside = overlay.contains(document.activeElement);
    document.getElementById('outbox-close').click();
    return { inside };
  })())`));
  checks.check("shift+Tab does not escape the modal either", reverse.inside, reverse);

  // ---- focus returns to the BADGE that opened the panel, not the sidebar row ----
  const badgeFocus = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const badge = document.querySelector('.outbox-badge');
    badge.focus();
    badge.click();
    document.getElementById('outbox-close').click();
    return { backOnBadge: document.activeElement === badge };
  })())`));
  checks.check("focus returns to the card badge that opened the panel",
    badgeFocus.backOnBadge, badgeFocus);

  // ---- a refresh landing after a successful answer must not undo it ----
  const stale = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    const ENTRIES = [{ id: 1, type: 'question', kind: 'ask', project: 'a', title: 't', body: '',
      bodyHtml: '', entryHash: 'h1', itemSlug: null, answer: null, answerable: true }];
    outbox = { readAt: 'start', entries: ENTRIES, anomalies: [] };
    window.fetch = (u, o) => {
      if (String(u).includes('/answer')) {
        return Promise.resolve(new Response(JSON.stringify({ readAt: 'answered',
          entries: [{ ...ENTRIES[0], answer: '(a)' }], anomalies: [] }),
          { headers: { 'content-type': 'application/json' } }));
      }
      if (String(u).includes('/api/outbox')) {
        // a GET issued BEFORE the answer, resolving after it, carrying the old state
        return new Promise((r) => setTimeout(() => r(new Response(
          JSON.stringify({ readAt: 'stale', entries: ENTRIES, anomalies: [] }),
          { headers: { 'content-type': 'application/json' } })), 120));
      }
      return original(u, o);
    };
    const refresh = fetchOutbox();
    await sendAnswer(1, '(a)');
    await refresh;
    window.fetch = original;
    return JSON.stringify({ readAt: outbox.readAt });
  })()`));
  checks.check("a slow refresh cannot undo an answer that already landed",
    stale.readAt === "answered", stale);

  await removeOpenEntryFixture(page);
}

export async function runOutboxAnswerFlowChecks(page: Page, baseUrl: string, checks: Checks): Promise<void> {
  await page.navigate(`${baseUrl}/`);

  // every check here acts on `.entry-answer-form`, which only an OPEN entry renders
  await installOpenEntryFixture(page);

  const opened = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    document.getElementById('outbox-row').click();
    const active = document.activeElement;
    return { isComposer: active && active.tagName === 'TEXTAREA' };
  })())`));
  checks.check("opening the panel puts the caret in the answer box", opened.isComposer, opened);

  const blank = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const form = document.querySelector('.entry-answer-form');
    const send = form.querySelector('button[type="submit"]');
    const box = form.querySelector('textarea');
    const whenBlank = send.disabled;
    box.value = 'something';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const whenTyped = send.disabled;
    box.value = '   ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { whenBlank, whenTyped, whenWhitespace: send.disabled };
  })())`));
  checks.check("Send is disabled while the draft is blank", blank.whenBlank === true, blank);
  checks.check("and enabled once something is typed", blank.whenTyped === false, blank);
  checks.check("whitespace alone does not count as an answer", blank.whenWhitespace === true, blank);

  const cancel = JSON.parse(await page.evaluate(`JSON.stringify((() => {
    const form = document.querySelector('.entry-answer-form');
    const id = Number(form.dataset.answer);
    const box = form.querySelector('textarea');
    box.value = 'a draft to abandon';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('[data-cancel="' + id + '"]');
    if (btn) btn.click();
    const after = document.querySelector('[data-answer="' + id + '"]');
    return { hadButton: !!btn, value: after ? after.querySelector('textarea').value : null };
  })())`));
  checks.check("an unsent draft can be cancelled", cancel.hadButton === true, cancel);
  checks.check("and cancelling clears it", cancel.value === "", cancel);

  // a 409 that reports the entry as ANSWERED by someone else must still show the draft
  const conflict = JSON.parse(await page.evaluate(`(async () => {
    const original = window.fetch;
    const entry = outbox.entries.find((e) => !(e.answer && e.answer.trim()));
    const id = entry.id;
    window.fetch = (u, o) => String(u).includes('/answer')
      ? Promise.resolve(new Response(JSON.stringify({
          error: 'entry changed since it was loaded',
          payload: { readAt: 'x', anomalies: [], entries: outbox.entries.map((e) =>
            e.id === id ? { ...e, answer: 'someone else got there first' } : e) },
        }), { status: 409, headers: { 'content-type': 'application/json' } }))
      : original(u, o);
    await sendAnswer(id, 'my draft');
    window.fetch = original;
    const form = document.querySelector('[data-answer="' + id + '"]');
    return JSON.stringify({
      draftKept: form ? form.querySelector('textarea').value : null,
      showsTheirs: document.getElementById('outbox-body').textContent.includes('someone else got there first'),
    });
  })()`));
  checks.check("a conflict that answers the entry still shows the operator's draft",
    conflict.draftKept === "my draft", conflict);
  checks.check("and shows the answer that beat it", conflict.showsTheirs === true, conflict);

  await removeOpenEntryFixture(page);
}
