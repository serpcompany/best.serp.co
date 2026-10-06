const MSGBTN = Button('Message the reviewers', { v: 'outline', size: 'sm', icon: 'msg' });
/* ============ 5. /account overview (dashboard-01: SectionCards + DataTable) ============ */
function sectionCards(badgeFail) {
  const card = (desc, val, badge, f1, f2) => Card({ desc, title: val, descFirst: true, titleCls: 'text-2xl font-semibold tabular-nums', action: badge, cls: 'gap-4', footer: `<div class="line-clamp-1 flex gap-2 font-medium">${f1}</div><div class="text-muted-foreground">${f2}</div>`, footerCls: 'flex-col items-start gap-1.5 text-sm' });
  return `<div class="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @md:grid-cols-2 @xl:grid-cols-4 dark:*:data-[slot=card]:bg-card">
    ${card('Needs your action', '3', Badge('To do', { v: 'outline', icon: icon('clock') }), 'Tablesmith, Clipwise, Pagecraft', 'Finish or fix these to get reviewed')}
    ${card('In review', '1', Badge('Queued', { v: 'outline', icon: icon('loader') }), 'Quillmate', 'We email you when it’s reviewed')}
    ${card('Live', '2', Badge('1 paid', { v: 'outline', icon: icon('ok') }), 'Ledgerly, Voxbloom', 'Visible on best.serp.co')}
    ${badgeFail ? card('Badge checks', '1 failing', Badge('Recheck in 23 h', { v: 'outline', icon: icon('warn', 'text-amber-500') }), 'Ledgerly: link is nofollow', 'Fix it before Tue, Oct 6, 09:14 UTC') : card('Badge checks', 'Passing', Badge('Weekly', { v: 'outline', icon: icon('ok') }), 'Ledgerly checked Mon, Oct 5', 'Free listings are checked weekly')}
  </div>`;
}
function acctTable(o = {}) {
  const prod = (p, sub) => `<div class="flex items-center gap-3">${logo(p, 32, { r: 'rounded-sm' })}<div class="min-w-0"><a class="font-medium hover:underline">${p.name}</a><p class="text-xs text-muted-foreground">${sub || p.domain}</p></div></div>`;
  const notChosen = '<span class="text-muted-foreground">\u2014</span>';
  const rows = [
    [P.table, `<div class="flex flex-col items-start gap-1">${Status('plan_draft')}<span class="text-xs text-muted-foreground" data-rev4>Expires in 30 days</span></div>`, notChosen, 'Oct 6', 'Choose free or paid', Button('Continue', { size: 'sm' })],
    [P.clip, Status('pending_badge'), Plan(false), 'Oct 6', 'Add the badge to your site', Button('Add badge', { size: 'sm' })],
    [P.quill, Status('in_review'), Plan(false), 'Oct 6', 'Waiting for a reviewer', ''],
    [P.page, Status('changes'), Plan(false), 'Oct 4', 'Fix and resubmit', Button('Edit', { size: 'sm' })],
    [P.ledger, Status('live'), Plan(false), 'Oct 5', o.badgeFail ? '<span class="text-amber-700 dark:text-amber-400">Badge failing · recheck Tue 09:14 UTC</span>' : 'Badge passing · checked Mon', Button('Badge', { size: 'sm', v: 'outline', icon: 'shield' })],
    [P.vox, Status('live_paid'), Plan(true), 'Oct 6', 'Live; a reviewer still signs off', ''],
    [P.prompt, Status('rejected'), Plan(false), 'Oct 2', 'Rejected: parked domain', Button('Details', { size: 'sm', v: 'outline' })],
    [P.meal, Status('withdrawn'), Plan(false), 'Sep 28', 'You withdrew it', Button('Submit again', { size: 'sm', v: 'outline' })],
    [P.scrape, Status('unlisted'), Plan(false), 'Sep 30', 'Removed: badge missing twice', Button('Relist: $49', { size: 'sm' })]
  ].map(r => ({ sel: o.sel === r[0].name, cells: [prod(r[0], `${r[0].domain} · ${r[3]}`), r[1], r[2], `<span class="text-muted-foreground">${r[4]}</span>`, `<div class="flex items-center justify-end gap-1">${r[5]}${RowMenu()}</div>`] }));
  const tabs = [['all', 'All', 9], ['action', 'Needs action', 3], ['live', 'Live', 2], ['closed', 'Closed', 3]];
  return `<div class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-2"><div class="@lg:hidden">${selectBox({ value: 'All (9)', cls: 'h-8 w-40' })}</div><div class="hidden @lg:block">${Tabs(tabs, 'all')}</div><div class="flex items-center gap-2">${Button('Columns', { v: 'outline', size: 'sm', icon: 'columns', iconR: 'chevD', cls: 'hidden @md:flex' })}${Button('Submit a product', { v: 'outline', size: 'sm', icon: 'plus' })}</div></div>
    ${DataTable(['Product', 'Status', 'Plan', 'Next step', ''], rows, { right: [4] })}
    ${TableFooter('9 submissions and listings', 1, 1)}
    ${statusLegend()}
  </div>`;
}
function statusLegend() {
  const rows = [['plan_draft', 'Saved, but you haven\u2019t picked free or paid. Nothing is reviewed yet. Drafts expire after 30 days.'], ['pending_badge', 'You chose free. Install or verify the badge to send it to review.'], ['in_review', 'Waiting for a reviewer.'], ['changes', 'A reviewer asked for changes. Edit and resubmit.'], ['live', 'Published on best.serp.co.'], ['live_paid', 'Paid and published; a reviewer still signs off.'], ['rejected', 'Not approved. The reason is in the submission and in Messages.'], ['withdrawn', 'You withdrew it.'], ['unlisted', 'Removed after a confirmed badge miss. Relisting is paid.']];
  return `<div data-slot="collapsible" class="rounded-lg border"><div class="flex items-center justify-between px-4 py-3"><p class="text-sm font-medium">What the statuses mean</p>${Button('', { v: 'ghost', size: 'iconSm', icon: 'chevsUD', sr: 'Toggle' })}</div><dl class="grid gap-x-6 gap-y-3 border-t p-4 text-sm @md:grid-cols-2">${rows.map(([k, t]) => `<div class="flex flex-col items-start gap-1.5"><dt>${Status(k)}</dt><dd class="text-muted-foreground">${t}</dd></div>`).join('')}</dl></div>`;
}
function badgeDrawer(pass) {
  const hist = [
    ['Oct 5, 09:14', pass ? Status('pass') : Status('fail', 'Fail: nofollow'), 'Weekly'],
    ['Sep 28, 09:10', Status('pass'), 'Weekly'],
    ['Sep 21, 09:12', Status('inconclusive', 'Timed out'), 'Weekly'],
    ['Sep 3, 16:41', Status('pass'), 'You']
  ];
  return SideDrawer({
    title: 'Ledgerly badge', desc: 'Free listing · checked weekly',
    body: `${kv([['Last check', 'Mon, Oct 5, 2026, 09:14 UTC'], ['Result', pass ? Status('pass', 'Badge found, dofollow') : Status('fail', 'Link is nofollow')], ['Next check', pass ? 'Mon, Oct 12 (weekly)' : 'Tue, Oct 6, about 09:14 UTC (recheck)']])}
      ${pass ? '' : Alert('warning', 'Fix the badge before the recheck', 'The badge on https://ledgerly.app/ links to your listing with <code>rel="nofollow"</code>. If it’s still nofollow at the recheck, Ledgerly is unlisted, and the way back is a $49 paid listing.')}
      ${Separator()}
      <div data-slot="collapsible" class="flex flex-col gap-2">${Button('Badge code', { v: 'ghost', size: 'sm', iconR: 'chevsUD', cls: 'justify-between -mx-2' })}<div data-slot="textarea" class="w-full overflow-x-auto rounded-md border border-input px-3 py-2 font-mono text-[11px] leading-relaxed shadow-xs dark:bg-input/30"><pre class="whitespace-pre">${esc(embedCode(P.ledger))}</pre></div>${Button('Copy code', { v: 'outline', size: 'sm', icon: 'copy', cls: 'w-fit' })}</div>
      ${Separator()}
      <div class="flex flex-col gap-2"><p class="font-medium">History</p>${DataTable(['When (UTC)', 'Result', 'By'], hist.map(r => ({ cells: r })))}</div>`,
    footer: `${Button('Re-verify now', { icon: 'refresh' })}<p class="text-center text-xs text-muted-foreground"><b class="tabular-nums text-foreground">9 of 10</b> checks left · one every 30 seconds</p>${Button('Upgrade: $49 one-off', { v: 'outline' })}${Button('Close', { v: 'outline' })}`
  });
}
function overview(o = {}) {
  const crumbs = ['Account', 'Overview'];
  if (o.empty) {
    return shell('account', 'overview', crumbs, Empty({ icon: 'inbox', title: 'No listings yet', desc: 'Submit your product to get it reviewed and listed. Already on SERP? Find its listing and claim it.', actions: `${Button('Submit a product', { icon: 'plus' })}${Button('Find your listing', { v: 'outline', icon: 'search' })}`, cls: 'min-h-[420px]' }));
  }
  const upgrade = o.upgrade ? Card({ title: 'Skip the badge for Ledgerly', desc: 'Upgrade to a paid listing and the badge becomes optional. No more weekly checks, and the listing is permanent.', action: Button('Upgrade: $49 one-off'), cls: 'border-primary/30' }) : '';
  return shell('account', 'overview', crumbs, `${upgrade}${sectionCards(o.badge === 'fail')}${acctTable({ badgeFail: o.badge === 'fail', sel: o.badge ? 'Ledgerly' : '' })}`,
    { overlay: o.badge ? badgeDrawer(o.badge === 'pass') : '', clip: !!(o.badge || o.menu), menu: o.menu, sheet: o.menu });
}

/* ============ 6. Submission detail ============ */
function readOnlyCard(p, plan) {
  return Card({ title: 'What you submitted', content: kv([['Name', p.name], ['URL', `<span class="font-mono text-[13px]">https://${p.domain}/</span>`], ['Category', p.cat], ['Short description', `<span class="font-normal">${p.short}</span>`], ['Logo', logo(p, 32, { r: 'rounded-sm' })], ['Plan', plan]]) });
}
const histCard = items => Card({ title: 'History', content: Timeline(items) });
const twoCol = (main, aside) => `<div class="grid gap-6 @lg:grid-cols-[minmax(0,1fr)_260px]"><div class="flex min-w-0 flex-col gap-6">${main}</div><div class="flex flex-col gap-6">${aside}</div></div>`;

function subDetail(kind) {
  let p, head, body, overlay = '';
  if (kind === 'changes') {
    p = P.page;
    const fixed = 'Builds a small-business website from a short questionnaire, then lets you edit pages, forms, and SEO settings in a visual editor.';
    head = pageHead(p, p.name, `${Status('changes')}${Plan(false)}`, `${p.domain} · ${p.cat}`, `${MSGBTN}${Button('Withdraw', { v: 'outline', size: 'sm' })}`);
    body = twoCol(`${Alert('warning', 'Changes requested', '<p>“The short description reads like an ad (#1 best, 10x faster). Describe what Pagecraft does in plain terms. Also replace the logo: the current one is a screenshot of your homepage.”</p><p class="text-xs">From the SERP team · Sun, Oct 4, 2026</p>', { icon: 'msg' })}
      ${Card({ title: 'Edit and resubmit', content: FieldGroup(`<div class="grid gap-7 @md:grid-cols-2">${Field({ label: 'Name', value: 'Pagecraft' })}${Field({ label: 'Primary category', select: true, value: p.cat })}</div>
        ${Field({ label: 'Website URL', value: 'https://pagecraft.dev', mono: true, disabled: true, desc: 'To change the URL, withdraw this submission and submit again.' })}
        ${Field({ label: 'Short description', area: true, value: fixed, max: 160, tag: 'Edited' })}
        ${logoField({ mode: 'uploaded' })}
        ${Field({ label: 'Long description', opt: true, area: true, value: 'Answer eight questions about your business and Pagecraft drafts a five-page site with a contact form, booking page, and local SEO settings filled in.' })}`),
        footer: `<div class="flex w-full flex-col gap-3 @sm:flex-row @sm:items-center">${Button('Resubmit for review')}${FieldDescription('It goes back to the review queue, and we email you the result.')}</div>`, footerCls: 'border-t pt-6' })}`,
      histCard([['Changes requested', 'Sun, Oct 4, 15:02 UTC', 'warn'], ['In review', 'Sat, Oct 3, 11:40 UTC'], ['Badge verified', 'Sat, Oct 3, 11:40 UTC', 'ok'], ['Submitted', 'Sat, Oct 3, 11:31 UTC']]));
  } else if (kind === 'review' || kind === 'withdraw') {
    p = P.quill;
    head = pageHead(p, p.name, `${Status('in_review')}${Plan(false)}`, `${p.domain} · ${p.cat}`, `${MSGBTN}${Button('Withdraw', { v: 'outline', size: 'sm' })}`);
    body = twoCol(`${Alert('info', 'Waiting for a reviewer', 'Your badge checked out. We’ll email maya@quillmate.app when a reviewer has looked at Quillmate. You can withdraw it while it’s waiting.')}${readOnlyCard(p, 'Free (badge)')}${Card({ title: 'FAQs and links', desc: 'None yet. Add them now and they’re reviewed with the listing.', action: Button('Add', { v: 'outline', size: 'sm', icon: 'plus' }) })}`,
      histCard([['In review', 'Tue, Oct 6, 10:42 UTC', 'now'], ['Badge verified', 'Tue, Oct 6, 10:42 UTC', 'ok'], ['Submitted', 'Tue, Oct 6, 10:15 UTC']]));
    if (kind === 'withdraw') overlay = Dialog({ alert: true, title: 'Withdraw Quillmate?', desc: 'It leaves the review queue and won’t be published. To list it later, you’ll need to submit it again.', footer: `${Button('Cancel', { v: 'outline' })}${Button('Withdraw submission', { v: 'destructive' })}`, top: 'top-40' });
  } else if (kind === 'withdrawn') {
    p = P.quill;
    head = pageHead(p, p.name, `${Status('withdrawn')}${Plan(false)}`, `${p.domain} · ${p.cat}`, `${MSGBTN}${Button('Submit again', { size: 'sm' })}`);
    body = twoCol(`${Alert('default', 'You withdrew this submission', 'Withdrawn on Tue, Oct 6, 2026. It won’t be reviewed or published. To list Quillmate later, submit it again.', { icon: 'undo' })}${readOnlyCard(p, 'Free (badge)')}`,
      histCard([['Withdrawn by you', 'Tue, Oct 6, 11:05 UTC', 'err'], ['In review', 'Tue, Oct 6, 10:42 UTC'], ['Badge verified', 'Tue, Oct 6, 10:42 UTC', 'ok'], ['Submitted', 'Tue, Oct 6, 10:15 UTC']]));
  } else {
    const map = {
      rejected: [P.prompt, false, 'Rejected on Fri, Oct 2', 'promptdeck.io shows a domain-parking page with no product, so there’s nothing to list yet. Once the product is live, edit and resubmit.', 'Free (badge)', [['Rejected', 'Fri, Oct 2, 09:30 UTC', 'err'], ['In review', 'Thu, Oct 1, 18:02 UTC'], ['Badge verified', 'Thu, Oct 1, 18:02 UTC', 'ok'], ['Submitted', 'Thu, Oct 1, 17:55 UTC']]],
      refunded: [P.tutor, true, 'Rejected and refunded', 'kiddotutor.com still didn’t load when we reviewed it (the connection timed out).</p><p><b>Refund:</b> $49.00 to your original payment method, issued Mon, Oct 5. It can take 5 to 10 business days to show up.', 'Paid ($49, refunded)', [['Refunded $49.00', 'Mon, Oct 5, 14:11 UTC', 'ok'], ['Rejected', 'Mon, Oct 5, 14:11 UTC', 'err'], ['Waiting for review (checks failed)', 'Sat, Oct 3, 20:30 UTC'], ['Paid $49.00', 'Sat, Oct 3, 20:30 UTC'], ['Submitted', 'Sat, Oct 3, 20:26 UTC']]],
      prohibited: [P.keyb, true, 'Rejected: prohibited content', 'keybazaar.shop sells software license keys that the publishers haven’t authorized. Our Terms of Service prohibit IP infringement, so this payment isn’t refunded.</p><p><b>This URL can’t be submitted again.</b> If you think this is a mistake, message us.', 'Paid ($49, not refunded)', [['Rejected (prohibited, no refund)', 'Mon, Oct 5, 16:40 UTC', 'err'], ['Unpublished', 'Mon, Oct 5, 16:40 UTC'], ['Live (paid, in review)', 'Sun, Oct 4, 12:03 UTC'], ['Paid $49.00', 'Sun, Oct 4, 12:02 UTC'], ['Submitted', 'Sun, Oct 4, 11:58 UTC']]]
    }[kind];
    p = map[0];
    head = pageHead(p, p.name, `${Status('rejected')}${Plan(map[1])}`, `${p.domain} · ${p.cat}`, kind === 'prohibited' ? Button('Message us', { v: 'outline', size: 'sm', icon: 'msg' }) : `${MSGBTN}${Button('Edit and resubmit', { size: 'sm' })}`);
    body = twoCol(`${Alert('destructive', map[2], `<p><b>Reason:</b> ${map[3]}</p>`)}${readOnlyCard(p, map[4])}<p class="text-sm text-muted-foreground">The reason is also in your Messages, where you can reply to the reviewers.</p>`, histCard(map[5]));
  }
  return shell('account', 'submissions', ['Account', 'Submissions', p.name], `${head}${body}`, { overlay });
}

/* ============ 7. Live listing edit ============ */
function faqItem(q, a, isNew) {
  return `<div data-slot="item" class="${cx('flex items-start gap-3 rounded-md border p-4', isNew ? 'border-primary/40 bg-primary/5 dark:bg-primary/10' : 'border-border')}"><div class="flex min-w-0 flex-1 flex-col gap-3">${isNew ? Badge('New', { v: 'secondary' }) : ''}${inputBox({ value: q })}${textareaBox({ value: a })}</div>${Button('', { v: 'ghost', size: 'iconSm', icon: 'x', sr: 'Remove FAQ', cls: 'text-muted-foreground' })}</div>`;
}
function linkRow(l, u, o = {}) {
  return `<div class="flex flex-col gap-2"><div class="grid gap-2 @sm:grid-cols-[minmax(0,1fr)_2fr_auto]">${inputBox({ value: l })}${inputBox({ value: u, mono: true, invalid: !!o.err })}${Button('', { v: 'ghost', size: 'icon', icon: 'x', sr: 'Remove link', cls: 'text-muted-foreground' })}</div>${o.err ? FieldError(o.err) : ''}</div>`;
}
function liveEdit(kind) {
  const p = P.ledger;
  const head = pageHead(p, 'Edit Ledgerly', `${Status('live')}${kind === 'pending' ? Status('revision', 'Edits in review') : ''}`, 'ledgerly.app · /products/ledgerly.app/', `${MSGBTN}${Button('View live listing', { v: 'outline', size: 'sm', iconR: 'ext' })}`);
  if (kind === 'pending') {
    const newS = 'Sorts freelancer expenses from your bank feed into tax categories and prepares quarterly estimated tax worksheets for the IRS.';
    const diff = `<div class="flex flex-col divide-y">
      <div class="flex flex-col gap-2 pb-4"><p class="text-sm font-medium">Short description</p><p class="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-900 line-through decoration-red-500/50 dark:text-red-200">${p.short}</p><p class="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">${newS}</p></div>
      <div class="flex flex-col gap-2 py-4"><p class="text-sm font-medium">FAQs · 2 added</p><ul class="grid gap-1 text-sm"><li class="flex gap-2"><span class="font-semibold text-emerald-600 dark:text-emerald-400">+</span> Does Ledgerly file my taxes for me?</li><li class="flex gap-2"><span class="font-semibold text-emerald-600 dark:text-emerald-400">+</span> Which banks can I connect?</li></ul></div>
      <div class="flex flex-col gap-2 pt-4"><p class="text-sm font-medium">Links · 1 added</p><p class="flex flex-wrap gap-2 text-sm"><span class="font-semibold text-emerald-600 dark:text-emerald-400">+</span> Pricing <span class="font-mono text-[13px] text-muted-foreground">https://ledgerly.app/pricing</span></p></div></div>`;
    return shell('account', 'listings', ['Account', 'Listings', 'Ledgerly', 'Edit'], `${head}${Alert('info', 'Your edits are waiting for review', 'Submitted Tue, Oct 6, 10:20 UTC. Visitors see the current listing until a reviewer approves the changes. We’ll email you either way.', { actions: `${Button('Change pending edits', { v: 'outline', size: 'sm', icon: 'pencil' })}${Button('Discard edits', { v: 'ghost', size: 'sm', icon: 'trash' })}` })}${Card({ title: '4 changes in this revision', content: diff })}`);
  }
  const adding = kind === 'adding';
  const form = FieldGroup(`
    <div class="grid gap-7 @md:grid-cols-2">${Field({ label: 'Name', value: 'Ledgerly', disabled: true, desc: 'To change the name or URL, message the reviewers.' })}${Field({ label: 'Primary category', select: true, value: p.cat })}</div>
    ${Field({ label: 'Short description', area: true, value: p.short, max: 160 })}
    ${logoField({ mode: 'uploaded' })}
    ${Field({ label: 'Long description', opt: true, area: true, tall: true, value: '## How it works\nConnect your bank, and Ledgerly sorts each transaction into a Schedule C category. Every quarter it fills in a 1040-ES worksheet with the estimate it thinks you owe.', desc: 'Markdown supported.' })}
    ${Separator()}
    <fieldset data-slot="field-set" class="flex flex-col gap-4"><div><legend data-slot="field-legend" class="text-base font-medium">FAQs</legend>${FieldDescription('Shown on your listing page.')}</div>
      ${faqItem('Does Ledgerly file my taxes for me?', 'No. It prepares the worksheets and categories; you or your accountant file.')}
      ${adding ? faqItem('Which banks can I connect?', 'Most US banks and credit unions through Plaid, plus CSV import for everything else.', true) : ''}
      ${Button('Add FAQ', { v: 'outline', size: 'sm', icon: 'plus', cls: 'w-fit' })}</fieldset>
    <fieldset data-slot="field-set" class="flex flex-col gap-4"><div><legend data-slot="field-legend" class="text-base font-medium">Links</legend>${FieldDescription('Docs, pricing, changelog, socials.')}</div>
      ${linkRow('Docs', 'https://ledgerly.app/docs')}
      ${adding ? linkRow('Pricing', 'ledgerly.app/pricing', { err: 'Enter a full URL starting with https://' }) : ''}
      ${Button('Add link', { v: 'outline', size: 'sm', icon: 'plus', cls: 'w-fit' })}</fieldset>`);
  return shell('account', 'listings', ['Account', 'Listings', 'Ledgerly', 'Edit'], `${head}${Alert('default', 'Edits are reviewed before they go live', 'Visitors keep seeing the current listing until a reviewer approves your changes.')}${Card({ content: form, footer: `<div class="flex w-full flex-col gap-2 @sm:flex-row">${Button('Submit changes for review')}${Button('Cancel', { v: 'ghost' })}</div>`, footerCls: 'border-t pt-6' })}`);
}

/* ============ 8 + 9. Listing page (existing site page) and claim ============ */
function listingPage(p, o = {}) {
  const claim = o.claim ? `${Separator(false, 'bg-border/50')}<div class="flex flex-col gap-1"><p class="text-sm text-muted-foreground">Work at ${p.name}?</p>${Button('Claim this listing', { v: 'link', size: 'link', icon: 'verified', cls: 'w-fit text-foreground' })}</div>` : '';
  return `${o.ownerAlert ? `<div class="mx-auto w-full max-w-6xl px-6 pt-6">${o.ownerAlert}</div>` : ''}
  <section class="relative overflow-hidden border-b border-border/50 bg-gradient-to-b from-muted/30 via-background to-background">
    <div class="grid-bg absolute inset-0"></div>
    <div class="relative mx-auto w-full max-w-6xl px-6 py-8 @md:py-12">
      <nav class="flex items-center gap-2 text-sm text-muted-foreground"><a>Home</a>${icon('chevR', 'size-3.5')}<a>Products</a>${icon('chevR', 'size-3.5')}<span class="text-foreground">${p.name}</span></nav>
      <div class="mt-8 flex flex-col gap-6 @md:flex-row @md:items-start @md:gap-8">
        <div class="shrink-0"><div class="inline-block rounded-2xl border border-border/50 bg-card p-3 shadow-lg">${logo(p, 72)}</div></div>
        <div class="flex-1 space-y-4"><div class="flex flex-wrap items-start justify-between gap-4"><div class="flex flex-wrap items-center gap-3"><h1 class="text-3xl font-bold tracking-tight @md:text-4xl @lg:text-5xl">${p.name}</h1>${o.verified ? verifiedBadge(o.tip) : ''}</div><button class="grid size-11 place-items-center rounded-full border border-border bg-background shadow-sm" aria-label="Favorite">${icon('heart', 'size-5')}</button></div>
          <p class="max-w-2xl text-lg leading-relaxed text-muted-foreground">${p.short}</p></div>
      </div>
    </div>
  </section>
  <div class="mx-auto w-full max-w-6xl px-6 py-10">
    <div class="grid gap-10 @lg:grid-cols-[minmax(0,1fr)_340px]">
      <article class="min-w-0 space-y-5 text-[15px] leading-7">
        <p>Sales teams lose details between calls. ${p.name} joins your Zoom, Google Meet, or Teams calls, records them, and writes a summary with next steps, objections, and pricing questions pulled out.</p>
        <h2 class="border-b border-border pb-2 pt-2 text-2xl font-semibold tracking-tight">How ${p.name} works</h2>
        <p>After each call it drafts a follow-up email in your voice and fills the matching fields in HubSpot or Salesforce, so reps review instead of retyping.</p>
        <p>Managers get a weekly digest of deal risks across the team, with links back to the moments in each recording.</p>
      </article>
      <aside class="space-y-6">
        <a class="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20">Visit Site ${icon('ext')}</a>
        <div class="flex flex-col gap-6 rounded-2xl border border-border/50 bg-card/50 p-6">
          <div><span class="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">${icon('hash', 'size-3')} Category</span><div class="mt-1 flex flex-wrap gap-2"><a class="inline-flex rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium">${p.cat}</a></div></div>
          ${claim}
        </div>
        <div class="rounded-2xl border border-border/50 bg-card/50 p-6"><h2 class="text-sm font-semibold">Add a badge to your website. Click the badge below to copy the code.</h2><div class="mt-4 space-y-4">${badgeSvg('light', 200)}${badgeSvg('dark', 200)}</div></div>
      </aside>
    </div>
  </div>`;
}
function verifiedBadge(tip) {
  const b = Badge('Verified owner', { v: 'secondary', icon: icon('verified') });
  return tip ? Tooltip('The maker verified ownership of this listing', b) : b;
}
/* 410 Gone page for an unpublished listing (public layout) */
function gonePage() {
  const p = P.scrape;
  return `<section class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-16">
    ${Empty({ icon: 'eyeOff', title: `${p.name} is no longer listed`, desc: `This listing was removed from SERP. Browse other products in <a>${p.cat}</a>.`, actions: Button(`Browse ${p.cat}`, { v: 'outline', iconR: 'arrowR' }) })}
    ${Item({ v: 'muted', media: `<div class="flex size-8 items-center justify-center rounded-sm border bg-muted">${icon('verified')}</div>`, title: 'Is this your product?', desc: 'Sign in to relist it on SERP.', actions: Button('Relist it', { size: 'sm' }) })}
  </section>`;
}
function ownerAlert(kind) {
  if (kind === 'owner') return Alert('info', 'You manage this listing', 'Only you can see this. Badge passing, last checked Mon, Oct 5.', { icon: 'verified', actions: `${Button('Edit listing', { size: 'sm', icon: 'pencil' })}${Button('Open account', { size: 'sm', v: 'outline' })}` });
  if (kind === 'revision') return Alert('info', 'Your edits are in review', 'Only you can see this. Visitors see the current version until a reviewer approves your changes.', { icon: 'clock', actions: Button('View pending edits', { size: 'sm', v: 'outline' }) });
  return Alert('warning', 'The badge is missing on brieflow.ai', 'Only you can see this. We recheck around Wed, Oct 7, 09:00 UTC. Put the badge back before then to keep ownership; the listing stays up either way.', { actions: `${Button('Check badge now', { size: 'sm', icon: 'refresh' })}${Button('Get badge code', { size: 'sm', v: 'outline' })}` });
}

function claimDialog(step, o = {}) {
  const b = P.brief;
  const prog = n => `<div class="flex flex-col gap-2"><div class="flex justify-between text-xs text-muted-foreground"><span>${['Method', 'Work email', 'Code', o.paid ? 'Payment' : 'Badge'][n]}</span><span>Step ${n + 1} of 4</span></div>${Progress((n + 1) * 25)}</div>`;
  let body = '', footer = '', title = 'Claim Brieflow', desc = 'Prove you work at Brieflow to manage this listing.';
  if (step === 0) {
    body = `<div class="flex flex-col gap-4">${prog(0)}<div data-slot="radio-group" class="grid gap-3">${ChoiceCard('Install the badge (free)', 'Add our badge to brieflow.ai with a dofollow link to this listing. We check it weekly. If it’s removed, you lose ownership and the listing stays up.', !o.paid)}${ChoiceCard('Skip the badge: $49 one-off', 'No badge needed, and ownership doesn’t depend on one.', !!o.paid)}</div>${FieldDescription('Either way, you’ll confirm an email address at <b class="font-medium text-foreground">brieflow.ai</b>.')}</div>`;
    footer = `${Button('Cancel', { v: 'outline' })}${Button('Continue')}`;
  } else if (step === 1) {
    const err = o.err === 'webmail' ? 'Gmail addresses can’t confirm you work at Brieflow. Use an address at brieflow.ai.' : o.err === 'domain' ? 'That address is at brieflow.io. Use an email at brieflow.ai (subdomains like team.brieflow.ai work too).' : '';
    const val = o.err === 'webmail' ? 'jordan.lee@gmail.com' : o.err === 'domain' ? 'jordan@brieflow.io' : 'jordan@brieflow.ai';
    body = `<div class="flex flex-col gap-6">${prog(1)}${Field({ label: 'Your email at brieflow.ai', value: val, error: err, desc: 'We’ll send a 6-digit code. Personal addresses like Gmail or Outlook can’t be used.' })}</div>`;
    footer = `${Button('Back', { v: 'outline' })}${Button('Send code')}`;
  } else if (step === 2) {
    const err = o.err === 'expired' ? 'This code has expired. Send a new one.' : o.err === 'attempts' ? 'Too many incorrect codes. Wait 15 minutes, then request a new code.' : '';
    body = `<div class="flex flex-col gap-6">${prog(2)}<div data-slot="field" data-invalid="${!!err}" class="flex flex-col gap-3">${FieldLabel('Code sent to jordan@brieflow.ai', { invalid: !!err })}${InputOTP(o.err ? '730514' : '73', { invalid: !!err, active: o.err ? -1 : 2 })}${err ? FieldError(err) : FieldDescription('It expires in 10 minutes. Didn’t get it? Resend in <span class="tabular-nums">0:51</span>')}</div></div>`;
    footer = `${Button('Back', { v: 'outline' })}${o.err === 'expired' ? Button('Send a new code') : Button('Verify', { disabled: o.err === 'attempts' })}`;
  } else if (step === 3 && !o.paid) {
    body = `<div class="flex flex-col gap-4">${prog(3)}<p class="text-sm text-muted-foreground">Paste this into the HTML of https://brieflow.ai/ and keep the link dofollow.</p>${badgeSvg('light', 170)}<div data-slot="textarea" class="w-full overflow-x-auto rounded-md border border-input px-3 py-2 font-mono text-[11px] leading-relaxed shadow-xs dark:bg-input/30"><pre class="whitespace-pre">${esc(embedCode(b))}</pre></div><div class="flex items-center justify-between gap-2">${Button('Copy code', { v: 'outline', size: 'sm', icon: 'copy' })}<span class="text-xs text-muted-foreground">10 of 10 checks left</span></div></div>`;
    footer = `${Button('Back', { v: 'outline' })}${Button('Verify badge and claim', { icon: 'shield' })}`;
  } else if (step === 3 && o.paid) {
    body = `<div class="flex flex-col gap-4">${prog(3)}${Item({ media: logo(b, 40, { r: 'rounded-sm' }), title: 'Paid claim: Brieflow', desc: 'One-off payment, USD', actions: '<span class="text-base font-semibold tabular-nums">$49.00</span>' })}${FieldDescription('jordan@brieflow.ai is confirmed. You become the owner as soon as the payment goes through on Stripe.')}</div>`;
    footer = `${Button('Back', { v: 'outline' })}${Button('Continue to payment: $49', { iconR: 'arrowR' })}`;
  } else if (step === 'done') {
    title = 'You now manage Brieflow'; desc = 'It’s in your account. Edits you make are reviewed before they go live.';
    body = Alert('default', 'Keep the badge on brieflow.ai', 'We check it weekly. If it’s missing on two checks about 24 hours apart, ownership is removed. The listing stays up.', { icon: 'shield' });
    footer = `${Button('Edit listing', { v: 'outline' })}${Button('Open account')}`;
  } else if (step === 'owned') {
    title = 'Brieflow already has an owner'; desc = 'Someone has already verified that they own this listing.';
    body = FieldDescription('If you think that\u2019s a mistake, message us. We\u2019ll check with the current owner and can move the listing to you.');
    footer = `${Button('Close', { v: 'outline' })}${Button('Message us', { icon: 'msg' })}`;
  }
  return Dialog({ title, desc, body, footer, top: 'top-20', drawer: true });
}
