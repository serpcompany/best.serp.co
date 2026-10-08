/* ============ review console ============ */
const UI = { s: 0, st: 0, vp: 'desktop', th: 'auto', footer: false };
try {
  const saved = JSON.parse(localStorage.getItem('mockups-70') || '{}');
  if (saved.vp === 'desktop' || saved.vp === 'mobile') UI.vp = saved.vp;
  if (['auto', 'light', 'dark'].includes(saved.th)) UI.th = saved.th;
  if (typeof saved.footer === 'boolean') UI.footer = saved.footer;
} catch (e) { /* storage unavailable */ }
const savePrefs = () => { try { localStorage.setItem('mockups-70', JSON.stringify({ vp: UI.vp, th: UI.th, footer: UI.footer })); } catch (e) { /* ignore */ } };
const $ = s => document.querySelector(s);
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function siteIsDark() {
  if (UI.th !== 'auto') return UI.th === 'dark';
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function renderRail() {
  const groups = [['Submitter', 'Submitter (public)'], ['Admin', 'Admin'], ['Email', 'Emails']];
  let html = '';
  for (const [g, label] of groups) {
    html += `<h2>${label}</h2>`;
    SCREENS.forEach((S, i) => {
      if (S.group !== g) return;
      html += `<a href="#s${S.n}" data-i="${i}" ${i === UI.s ? 'aria-current="true"' : ''}><span class="num">${S.n}</span><span class="t">${S.title}${S.isNew ? `<span class="new">New r${S.isNew === true ? 2 : S.isNew}</span>` : ''}${S.rev4 ? '<span class="new r4">R4: needs approval</span>' : ''}${S.rev5 ? '<span class="new r4">R5: needs approval</span>' : ''}</span><span class="r">${esc(S.route)}</span><span class="cnt">${S.states.length}</span></a>`;
    });
  }
  html += `<div class="foot">Keys: <kbd>←</kbd> <kbd>→</kbd> states, <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> screens.<br>Copy is draft. Components follow shadcn/ui (apps/web/src/components/ui). Example products are fictional; categories are real D1 categories.</div>`;
  $('#rail').innerHTML = html;
  $('#screenSelect').innerHTML = SCREENS.map((S, i) => `<option value="${i}" ${i === UI.s ? 'selected' : ''}>${S.n}. ${S.title} (${S.states.length} states)</option>`).join('');
}

function renderNotes(S) {
  const li = a => `<ul>${a.map(x => `<li>${x}</li>`).join('')}</ul>`;
  const shellNote = S.shell ? `<div class="note approve"><p><span class="q">Proposal (Revision 2):</span> signed-in work areas use a dashboard shell instead of the public header and footer: ${S.shell === 'account' ? 'dashboard-01 for /account' : 'sidebar-07 for /admin'}. Approve or reject the shell separately from this screen, e.g. <code>shell: approved</code>.</p></div>` : '';
  $('#notes').innerHTML = `${shellNote}
    <div class="note"><h3>From #59 / #70, reflected here</h3>${li(S.notes.d)}</div>
    <div class="note"><h3>Assumptions and open questions</h3>${li(S.notes.a)}</div>
    <div class="note"><h3>shadcn/ui mapping</h3>${li(S.notes.m)}</div>
    <div class="note"><h3>Custom (no shadcn equivalent)</h3>${li(S.notes.c)}</div>
    <div class="note approve"><p>Approve per screen in a comment on issue #70, for example <code>approved: 1–4, 15; changes: 5 (…)</code>. All visible copy is draft and can change per screen.</p></div>`;
}

function fit() {
  const stage = $('#stage');
  const dev = $('#device');
  const vpEl = dev.querySelector('.viewport');
  const cs = getComputedStyle(stage);
  const avail = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let design;
  if (UI.vp === 'mobile') { vpEl.style.width = '390px'; design = 390 + 22; }
  else { design = Math.min(Math.max(avail, 1040), 1360); vpEl.style.width = (design - 2) + 'px'; }
  dev.style.width = design + 'px';
  dev.style.zoom = avail < design ? String(Math.max(avail / design, 0.3)) : '1';
}

function render(pushHash = true) {
  const S = SCREENS[UI.s];
  if (UI.st >= S.states.length) UI.st = 0;
  const st = S.states[UI.st];
  $('#sEyebrow').innerHTML = `Screen ${S.n} · ${S.group === 'Email' ? 'Emails' : S.group}${S.shell ? ' · dashboard shell' : ''}${S.isNew ? `<span class="new">New in revision ${S.isNew === true ? 2 : S.isNew}</span>` : ''}`;
  $('#sTitle').innerHTML = `${S.n}. ${S.title}<code>${esc(S.route)}</code>`;
  $('#states').innerHTML = S.states.map((x, i) => `<button type="button" class="chipbtn${x.extra ? ' extra' : ''}${x.rev4 || x.rev5 ? ' r4' : ''}" data-st="${i}" aria-pressed="${i === UI.st}"><span class="k">${LETTERS[i]}</span>${x.label}${x.rev4 ? '<span class="r4tag">R4 new</span>' : ''}${x.rev5 ? '<span class="r4tag">R5 new</span>' : ''}</button>`).join('');
  const isMail = st.url.startsWith('Mail');
  const isExternal = st.url.startsWith('checkout.');
  $('#url').innerHTML = isMail
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS.mail}</svg><b>${esc(st.url)}</b>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS.lock}</svg>${isExternal ? `<b>${esc(st.url)}</b>` : `best.serp.co<b>${esc(st.url)}</b>`}`;
  const frame = $('#frame');
  frame.classList.toggle('dark', siteIsDark());
  frame.innerHTML = st.html();
  const dev = $('#device');
  dev.className = `device ${UI.vp}`;
  renderNotes(S);
  document.querySelectorAll('#rail a').forEach(a => a.toggleAttribute('aria-current', Number(a.dataset.i) === UI.s));
  document.querySelectorAll('#rail a[aria-current]').forEach(a => a.setAttribute('aria-current', 'true'));
  $('#screenSelect').value = String(UI.s);
  $('#prevBtn').disabled = UI.s === 0;
  $('#nextBtn').disabled = UI.s === SCREENS.length - 1;
  document.querySelectorAll('#vpSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.vp === UI.vp)));
  document.querySelectorAll('#thSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.th === UI.th)));
  $('#footerToggle').checked = UI.footer;
  if (pushHash) { try { history.replaceState(null, '', `#s${S.n}-${st.id}`); } catch (e) { /* ignore */ } }
  fit();
}

function go(s, st = 0) { UI.s = Math.max(0, Math.min(SCREENS.length - 1, s)); UI.st = st; render(); }

function fromHash() {
  const m = /^#s(\d+b?)(?:-([a-z0-9]+))?$/i.exec(location.hash || '');
  if (!m) return false;
  const i = SCREENS.findIndex(S => String(S.n) === m[1].toLowerCase());
  if (i < 0) return false;
  UI.s = i;
  const j = m[2] ? SCREENS[i].states.findIndex(x => x.id === m[2]) : 0;
  UI.st = j < 0 ? 0 : j;
  return true;
}

$('#rail').addEventListener('click', e => { const a = e.target.closest('a[data-i]'); if (!a) return; e.preventDefault(); go(Number(a.dataset.i)); window.scrollTo({ top: 0 }); });
$('#screenSelect').addEventListener('change', e => go(Number(e.target.value)));
$('#states').addEventListener('click', e => { const b = e.target.closest('[data-st]'); if (!b) return; UI.st = Number(b.dataset.st); render(); });
$('#prevBtn').addEventListener('click', () => go(UI.s - 1));
$('#nextBtn').addEventListener('click', () => go(UI.s + 1));
$('#vpSeg').addEventListener('click', e => { const b = e.target.closest('[data-vp]'); if (!b) return; UI.vp = b.dataset.vp; savePrefs(); render(false); });
$('#thSeg').addEventListener('click', e => { const b = e.target.closest('[data-th]'); if (!b) return; UI.th = b.dataset.th; savePrefs(); render(false); });
$('#footerToggle').addEventListener('change', e => { UI.footer = e.target.checked; savePrefs(); render(false); });
$('#frame').addEventListener('click', e => { if (e.target.closest('a, button')) e.preventDefault(); });
document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) go(UI.s + d);
    else { const n = SCREENS[UI.s].states.length; UI.st = (UI.st + d + n) % n; render(); }
    e.preventDefault();
  }
});
window.addEventListener('hashchange', () => { if (fromHash()) render(false); });
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (UI.th === 'auto') render(false); }); } catch (e) { /* ignore */ }
new MutationObserver(() => { if (UI.th === 'auto') $('#frame').classList.toggle('dark', siteIsDark()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(fit)).observe($('#stage'));
else window.addEventListener('resize', fit);

fromHash();
renderRail();
render(false);
