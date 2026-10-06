/* ============ admin helpers ============ */
const adminTitle = (t, d, actions = '') => `<div class="flex flex-col gap-3 @md:flex-row @md:items-end @md:justify-between"><div class="space-y-1"><h1 class="text-2xl font-semibold tracking-tight">${t}</h1>${d ? `<p class="text-sm text-muted-foreground">${d}</p>` : ''}</div>${actions ? `<div class="flex flex-wrap gap-2">${actions}</div>` : ''}</div>`;
const filterInput = (v, ph) => `<div class="w-full @sm:w-[180px] @lg:w-[250px]">${inputBox({ value: v, ph }).replace('h-9', 'h-8')}</div>`;
const prodCell = (p, sub) => `<div class="flex items-center gap-3">${logo(p, 32, { r: 'rounded-sm' })}<div class="min-w-0"><a class="font-medium hover:underline">${p.name}</a><p class="text-xs text-muted-foreground">${sub || p.domain}</p></div></div>`;
const sortHead = l => `<span class="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-accent">${l}${icon('arrowUpDown', 'size-3.5 text-muted-foreground')}</span>`;

/* ============ 10. Review queue ============ */
function queue(o = {}) {
  let rows = [
    [P.tutor, '3 d', 'Submission', Plan(true), Status('na', 'Optional'), '$49.00', Status('paid_wait', 'Checks failed')],
    [P.brief, '3 d', 'Revision', Plan(false), Status('pass'), '—', Status('revision'), 'Owner jordan@brieflow.ai'],
    [P.ship, '2 d', 'Submission', Plan(false), Status('pass'), '—', Status('in_review')],
    [P.ledger, '1 d', 'Revision', Plan(false), Status('pass'), '—', Status('revision')],
    [P.quill, '5 h', 'Submission', Plan(false), Status('pass'), '—', Status('in_review')],
    [P.vox, '2 h', 'Submission', Plan(true), Status('na', 'Optional'), '$49.00', Status('live_paid')]
  ];
  if (o.filter) rows = rows.filter(r => r[5] !== '—');
  const planFacet = `<div class="relative inline-flex">${Facet('Plan', o.filter ? ['Paid'] : [])}${o.filter ? `<div class="absolute left-0 top-full z-50 mt-1">${CommandList('Plan', [['Free', 4, false], ['Paid', 2, true]])}</div>` : ''}</div>`;
  const toolbar = `<div class="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">${Tabs([['waiting', 'Waiting', 6], ['changes', 'Changes requested', 1], ['all', 'All', null]], 'waiting')}<div class="flex flex-wrap items-center gap-2">${filterInput('', 'Filter by name or domain…')}${Facet('Source')}${planFacet}${Facet('Badge')}${o.filter ? Button('Reset', { v: 'ghost', size: 'sm', iconR: 'x' }) : ''}</div></div>`;
  const body = o.empty
    ? Empty({ icon: 'inbox', title: 'Queue is clear', desc: 'New submissions show up here once their badge is verified or their payment goes through. Revisions to live listings show up too.', cls: 'min-h-[360px]' })
    : `${DataTable(['Product', sortHead('Age'), 'Source', 'Plan', 'Badge', 'Paid', 'Status', ''], rows.map(r => ({ cells: [prodCell(r[0], r[7]), `<span class="tabular-nums">${r[1]}</span>`, r[2], r[3], r[4], `<span class="tabular-nums text-muted-foreground">${r[5]}</span>`, r[6], RowMenu()] })), { right: [7] })}${TableFooter(`${rows.length} of 6 waiting`, 1, 1)}`;
  return shell('admin', 'queue', ['Admin', 'Review queue'], `${adminTitle('Review queue', o.empty ? 'Nothing waiting' : '6 waiting · oldest 3 days')}<div class="flex flex-col gap-4">${toolbar}${body}</div>`, { icons: o.icons, menu: o.menu, sheet: o.menu, clip: o.menu });
}

/* ============ 11. Review detail ============ */
function miniListing(p) {
  return `<div class="overflow-hidden rounded-lg border"><div class="relative border-b border-border/50 bg-gradient-to-b from-muted/30 to-background"><div class="grid-bg absolute inset-0"></div><div class="relative flex flex-col gap-4 p-6 @sm:flex-row @sm:items-start"><div class="inline-block w-fit rounded-2xl border border-border/50 bg-card p-2.5 shadow-lg">${logo(p, 56)}</div><div class="space-y-2"><h3 class="text-3xl font-bold tracking-tight">${p.name}</h3><p class="text-muted-foreground">${p.short}</p></div></div></div>
    <div class="grid gap-6 p-6 @xl:grid-cols-[minmax(0,1fr)_200px]"><div class="space-y-3 text-sm leading-7"><h4 class="border-b pb-1 text-lg font-semibold">What ${p.name} does</h4><p>${p.name} reads your product notes, changelog, and past launches, then drafts landing pages, emails, and ad variations in your team’s voice.</p><h4 class="border-b pb-1 text-lg font-semibold">Who it is for</h4><p>Small marketing teams and founders who ship often and write their own copy.</p></div>
    <div class="space-y-3"><div class="rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground">Visit Site</div><div class="rounded-xl border border-border/50 p-4"><p class="font-mono text-xs uppercase tracking-wider text-muted-foreground">Category</p><span class="mt-1 inline-flex rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium">${p.cat}</span></div></div></div></div>`;
}
function reviewDetail(kind) {
  const paid = ['paid', 'rejectPaid', 'rejectPaidProhibited', 'rejectConfirm'].includes(kind);
  const p = paid ? P.vox : P.quill;
  const editing = kind === 'edit';
  const chips = paid ? `${Status('live_paid')}${Plan(true)}` : `${Status('in_review')}${Plan(false)}${Status('pass', 'Badge pass')}`;
  const meta = paid ? 'Submission s_8m2q1d · waiting 2 h · hello@voxbloom.fm' : 'Submission s_4f9k2c · waiting 5 h · maya@quillmate.app';
  const actions = editing ? `${Button('Cancel edits', { v: 'ghost', size: 'sm' })}${Button('Approve with edits', { size: 'sm', icon: 'check' })}`
    : paid ? `${Button('Request changes', { v: 'outline', size: 'sm' })}${Button('Reject and unpublish', { v: 'outline', size: 'sm', cls: 'text-destructive' })}${Button('Approve (keep live)', { size: 'sm', icon: 'check' })}`
      : `${Button('Request changes', { v: 'outline', size: 'sm' })}${Button('Reject', { v: 'outline', size: 'sm', cls: 'text-destructive' })}${Button('Edit, then approve', { v: 'outline', size: 'sm', icon: 'pencil' })}${Button('Approve', { size: 'sm', icon: 'check' })}`;
  const editedShort = 'Turns rough product notes into on-brand landing pages, emails, and ads, using a style guide so every draft sounds like your team.';
  const left = editing
    ? Card({ title: 'Edit before approving', desc: '2 fields edited. Your edits are logged with the approval.', content: FieldGroup(`<div class="grid gap-7 @md:grid-cols-2">${Field({ label: 'Name', value: 'Quillmate' })}${Field({ label: 'Primary category', select: true, value: 'AI Copywriting' })}</div>${Field({ label: 'Short description', area: true, value: editedShort, max: 160, tag: Badge('Edited', { v: 'secondary' }) })}${logoField({ mode: 'uploaded' })}${Field({ label: 'Long description', opt: true, area: true, tall: true, value: P.quill.long, tag: Badge('Edited', { v: 'secondary' }) })}`) })
    : Card({ title: 'Preview', desc: `/products/${p.domain}/ · ${paid ? 'public now' : 'not public yet'}`, content: miniListing(p) });
  const right = `${Card({ title: 'Submitted', cls: 'gap-4', content: kv([['URL', `<span class="font-mono text-[13px]">https://${p.domain}/</span>`], ['Matched on', `<span class="font-mono text-[13px]">${p.domain}</span>, no duplicate`], ['Category', p.cat], ['Plan', paid ? 'Paid · ORD-1041 · $49.00' : 'Free (badge)'], ['Logo', paid ? 'Uploaded, 512 × 512' : 'Site icon from quillmate.app']]) })}
    ${Card({ title: 'Outbound link', desc: 'Default for new submissions is nofollow.', cls: 'gap-4', content: ToggleGroup(['follow', 'nofollow', 'sponsored'], 'nofollow') })}
    ${paid ? Card({ title: 'Badge', desc: 'Optional for paid listings. Not checked.', cls: 'gap-4' }) : Card({ title: 'Badge checks', cls: 'gap-4', content: `<div class="flex items-center justify-between gap-2 text-sm"><span>Tue, Oct 6, 10:42</span>${Status('pass')}</div><p class="mt-2 text-xs text-muted-foreground">Dofollow link to /products/quillmate.app/ found on https://quillmate.app/. 1 of 10 checks used.</p>` })}
    ${paid ? '' : reviewThreadPanel()}
    ${Card({ title: 'Submitter', cls: 'gap-4', content: `<div class="flex items-center gap-3">${Avatar(paid ? 'HV' : 'MO')}<div class="min-w-0 text-sm"><p class="truncate font-medium">${paid ? 'hello@voxbloom.fm' : 'maya@quillmate.app'}</p><p class="text-xs text-muted-foreground">Since Oct 6, 2026 · ${paid ? 'no other listings' : '8 other submissions'}</p></div></div>` })}`;
  const paidBanner = paid ? Alert('info', 'Live since Tue, Oct 6, 08:12 UTC, after payment', 'Automatic checks passed: public URL, page loads (HTTP 200), not a duplicate, safe-fetch rules. Approving keeps it live. Rejecting unpublishes it, and refunds unless you tag it prohibited.') : '';
  const body = `${pageHead(p, p.name, chips, meta, actions)}${paidBanner}<div class="grid gap-6 @xl:grid-cols-[minmax(0,1fr)_300px]"><div class="min-w-0">${left}</div><div class="flex flex-col gap-4">${right}</div></div>`;
  const cats = sel => `<fieldset data-slot="field-set" class="flex flex-col gap-3"><legend data-slot="field-legend" class="mb-3 text-sm font-medium">Category</legend><div data-slot="radio-group" class="grid gap-3">${ChoiceCard('Prohibited by the Terms', paid ? 'No refund.' : 'Malware, scams, illegal goods, IP infringement, hate, impersonation, spam or parked pages.', sel === 'prohibited')}${ChoiceCard('Other', paid ? 'Full refund of $49.00, automatically.' : 'Anything else. The submitter can edit and resubmit.', sel === 'other')}</div></fieldset>`;
  let overlay = '';
  if (kind === 'approve') overlay = Dialog({ alert: true, title: 'Approve and publish Quillmate?', desc: 'It’s published to production and the decision is logged under your name.', body: kv([['Goes live at', '/products/quillmate.app/, within about a minute'], ['Outbound link', 'nofollow'], ['Email', '“Approved” to maya@quillmate.app']]), footer: `${Button('Cancel', { v: 'outline' })}${Button('Approve and publish')}` });
  if (kind === 'changes') overlay = Dialog({ title: 'Request changes', desc: 'Quillmate leaves the queue until the submitter resubmits.', body: Field({ label: 'Note to the submitter', area: true, value: 'The logo is blurry at small sizes. Please upload a square version at least 256 × 256 px. Everything else looks good.', desc: 'Also posted to your conversation with maya@quillmate.app, where they can reply. They get an email that there\u2019s an update.' }), footer: `${Button('Cancel', { v: 'outline' })}${Button('Send request')}` });
  if (kind === 'reject') overlay = Dialog({ title: 'Reject Quillmate', desc: 'Free submission. No payment to refund.', body: FieldGroup(`${Field({ label: 'Reason', area: true, value: 'quillmate.app redirects to a waitlist page. There\u2019s no product to try yet.', desc: 'Shown in their account and also posted to your conversation with them.' })}${cats('other')}`, 'gap-6'), footer: `${Button('Cancel', { v: 'outline' })}${Button('Reject', { v: 'destructive' })}`, top: 'top-16' });
  if (kind === 'rejectPaid' || kind === 'rejectPaidProhibited') {
    const pro = kind === 'rejectPaidProhibited';
    overlay = Dialog({ title: 'Reject Voxbloom', desc: 'Voxbloom is live and paid (ORD-1041, $49.00). Rejecting unpublishes it right away.', body: FieldGroup(`${Field({ label: 'Reason', area: true, value: pro ? 'The voices on voxbloom.fm are cloned from named celebrities without their permission (impersonation).' : 'Voxbloom is already listed as voxbloom.ai. We keep one listing per product.', desc: 'Shown in their account and also posted to your conversation with them.' })}${cats(pro ? 'prohibited' : 'other')}${Alert(pro ? 'warning' : 'default', pro ? 'No refund' : 'Refund $49.00 automatically', 'Unpublish now and email the rejection with this reason.')}`, 'gap-6'), footer: `${Button('Cancel', { v: 'outline' })}${Button(pro ? 'Reject without refund' : 'Reject and refund $49.00', { v: 'destructive' })}`, top: 'top-8' });
  }
  if (kind === 'rejectConfirm') overlay = Dialog({ alert: true, title: 'Reject Voxbloom and refund $49.00?', desc: 'This unpublishes /products/voxbloom.fm/ within about a minute and refunds $49.00 through Stripe. It can’t be undone from here.', footer: `${Button('Go back', { v: 'outline' })}${Button('Yes, reject and refund', { v: 'destructive' })}`, top: 'top-32' });
  return shell('admin', 'queue', ['Admin', 'Review queue', p.name], body, { overlay });
}

/* ============ 12. Listings ============ */
function listings(kind) {
  if (kind === 'search') {
    const rows = [
      [P.brief, Status('live'), 'Admin (import)', 'jordan@brieflow.ai', 'Free · badge claim', 'follow', 'Oct 1'],
      [P.debrief, Status('live'), 'Admin (import)', 'ops@debrief.so', 'Paid claim', 'follow', 'Oct 5'],
      [P.briefly, Status('unlisted'), 'Submission', '—', 'Free', 'nofollow', 'Sep 30']
    ];
    const table = DataTable(['Product', 'Status', 'Source', 'Owner', 'Plan', 'Link', 'Updated', ''], rows.map(r => ({ sel: r[0] === P.brief, cells: [prodCell(r[0]), r[1], r[2], r[3] === '—' ? '<span class="text-muted-foreground">None</span>' : r[3], r[4], `<code class="font-mono text-[13px]">${r[5]}</code>`, `<span class="text-muted-foreground">${r[6]}</span>`, RowMenu()] })), { right: [7] });
    const menu = `<div class="absolute right-3 top-[92px] z-30 w-48">${Menu([{ t: 'Open', icon: 'pencil', focus: true }, { t: 'View live', icon: 'ext' }, { t: 'Copy URL', icon: 'copy' }, { t: 'Transfer owner…', icon: 'users' }, '-', { t: 'Unpublish…', icon: 'eyeOff', danger: true }])}</div>`;
    return shell('admin', 'listings', ['Admin', 'Listings'], `${adminTitle('Listings', '3,431 listings', Button('Add listing', { size: 'sm', icon: 'plus' }))}<div class="flex flex-col gap-4"><div class="flex flex-wrap items-center gap-2">${filterInput('brief', '')}${Facet('Status')}${Facet('Source')}${Facet('Link')}${Button('Reset', { v: 'ghost', size: 'sm', iconR: 'x' })}</div><div class="relative">${table}${menu}</div>${TableFooter('3 of 3,431 listings match “brief”', 1, 1)}</div>`);
  }
  const p = P.brief;
  const unpub = kind === 'unpublished';
  const head = pageHead(p, 'Brieflow', Status(unpub ? 'unlisted' : 'live'), 'brieflow.ai · added by admin import, May 16, 2026 · /products/brieflow.ai/', unpub ? Button('Republish', { size: 'sm', icon: 'undo' }) : `${Button('View live', { v: 'outline', size: 'sm', iconR: 'ext' })}${Button('Unpublish', { v: 'outline', size: 'sm', cls: 'text-destructive' })}`);
  const hist = [['Oct 5', Status('pass'), 'Weekly'], ['Sep 28', Status('pass'), 'Weekly'], ['Sep 22', Status('pass'), 'Recheck'], ['Sep 21', Status('miss_warn', 'Missing'), 'Weekly'], ['Sep 3', Status('pass'), 'Claim']];
  const body = `${head}${unpub ? Alert('default', 'Unpublished Tue, Oct 6 by devin@serp.co', 'Note: “Owner asked to take it down while they rebrand.” Removed from the site, search, sitemap and RSS. The URL returns 410 Gone with a page that points to its category. Republish to bring it back.', { icon: 'eyeOff' }) : ''}
    <div class="grid gap-6 @xl:grid-cols-[minmax(0,1fr)_320px]">
      <div class="min-w-0">${Card({ title: 'Details', content: FieldGroup(`<div class="grid gap-7 @md:grid-cols-2">${Field({ label: 'Name', value: 'Brieflow' })}${Field({ label: 'Primary category', select: true, value: p.cat })}</div>${Field({ label: 'Website URL', value: 'https://brieflow.ai', mono: true })}${Field({ label: 'Short description', area: true, value: p.short, max: 160 })}${logoField({ mode: 'uploaded' })}`), footer: `<div class="flex w-full flex-col gap-3 @sm:flex-row @sm:items-center">${Button('Save changes')}${FieldDescription('Saves to production and is logged under your name.')}</div>`, footerCls: 'border-t pt-6' })}</div>
      <div class="flex flex-col gap-4">
        ${Card({ title: 'Outbound link', desc: 'The rel on the Visit Site link. Defaults: follow for admin-added listings, nofollow for new submissions.', cls: 'gap-4', content: ToggleGroup(['follow', 'nofollow', 'sponsored'], 'follow') })}
        ${Card({ title: 'Owner', cls: 'gap-4', content: `<div class="flex flex-col gap-3">${Item({ media: Avatar('JL'), title: 'jordan@brieflow.ai', desc: 'Badge claim · Thu, Sep 3, 2026', cls: '!p-0 !border-0' })}${FieldDescription('Badge claim: weekly checks are on. If the badge is confirmed missing, ownership is removed and the listing stays live.')}<div class="flex flex-wrap gap-2">${Button('Transfer', { v: 'outline', size: 'sm', icon: 'users' })}${Button('Remove owner', { v: 'ghost', size: 'sm' })}</div></div>` })}
        ${Card({ title: 'Badge checks', cls: 'gap-4', content: DataTable(['Date', 'Result', 'Run'], hist.map(r => ({ cells: r }))) })}
        ${listingThreadPanel()}
        ${Card({ title: 'Activity', cls: 'gap-4', content: Timeline([['Owner set to jordan@brieflow.ai (badge claim)', 'Thu, Sep 3'], ['Link set to follow (admin-listing default)', 'Sat, May 16'], ['Imported from products.json', 'Sat, May 16']]) })}
      </div>
    </div>`;
  let overlay = '';
  if (kind === 'transfer') overlay = Dialog({ title: 'Transfer Brieflow', desc: 'Move ownership to another account. Logged under your name.', body: Field({ label: 'New owner’s email', value: 'priya@brieflow.ai', desc: 'They need a SERP account. jordan@brieflow.ai loses access right away.' }), footer: `${Button('Cancel', { v: 'outline' })}${Button('Transfer ownership')}`, top: 'top-28' });
  if (kind === 'unpublish') overlay = Dialog({ alert: true, title: 'Unpublish Brieflow?', desc: 'Within about a minute it leaves the site, search, sitemap and RSS, and its URL returns 410 Gone with a page that points to its category. You can republish it any time.', body: Field({ label: 'Note for the activity log', opt: true, value: 'Owner asked to take it down while they rebrand.' }), footer: `${Button('Cancel', { v: 'outline' })}${Button('Unpublish', { v: 'destructive' })}`, top: 'top-28' });
  return shell('admin', 'listings', ['Admin', 'Listings', 'Brieflow'], body, { overlay });
}

function blockedListing(kind) {
  const p = P.keyb;
  const head = pageHead(p, 'KeyBazaar', Status('blocked'), 'keybazaar.shop · paid submission by admin@keybazaar.shop · not public', Button('Allow resubmission', { v: 'outline', size: 'sm', icon: 'undo' }));
  const body = `${head}${Alert('destructive', 'Resubmission is blocked', '<p>Rejected as prohibited on Mon, Oct 5 by devin@serp.co: \u201ckeybazaar.shop sells software license keys that the publishers haven\u2019t authorized (IP infringement).\u201d No refund.</p><p>Nobody can submit, pay for, or claim this URL until an admin allows resubmission.</p>', { icon: 'ban' })}
    <div class="grid gap-6 @xl:grid-cols-[minmax(0,1fr)_320px]">
      <div class="min-w-0">${Card({ title: 'Details', desc: 'Read-only while the listing is blocked.', content: kv([['Name', 'KeyBazaar'], ['URL', '<span class="font-mono text-[13px]">https://keybazaar.shop/</span>'], ['Category', 'Other'], ['Short description', `<span class="font-normal">${p.short}</span>`], ['Order', 'ORD-1039 · $49.00 · not refunded (prohibited)']]) })}</div>
      <div class="flex flex-col gap-4">
        ${Card({ title: 'Submitter', cls: 'gap-4', content: Item({ media: Avatar('AK'), title: 'admin@keybazaar.shop', desc: 'Account since Oct 4, 2026', cls: '!p-0 !border-0' }) })}
        ${Card({ title: 'Activity', cls: 'gap-4', content: Timeline([['Rejected as prohibited, unpublished', 'Mon, Oct 5, 16:40 · devin@serp.co', 'err'], ['Live (paid, in review)', 'Sun, Oct 4, 12:03'], ['Paid $49.00', 'Sun, Oct 4, 12:02']]) })}
      </div>
    </div>`;
  const overlay = kind === 'liftblock' ? Dialog({ alert: true, title: 'Allow keybazaar.shop to be submitted again?', desc: 'The block is lifted. Anyone can then submit or claim this URL, and any new submission goes through review as usual. This is logged under your name.', footer: `${Button('Cancel', { v: 'outline' })}${Button('Allow resubmission')}`, top: 'top-32' }) : '';
  return shell('admin', 'listings', ['Admin', 'Listings', 'KeyBazaar'], body, { overlay });
}

/* ============ 13. Orders ============ */
function orders(kind) {
  const refunded = kind === 'refunded';
  const rows = [
    ['ORD-1045', 'Oct 6, 11:20', 'nina@clipwise.video', 'Paid listing', P.clip, 'o_pending', 'cs_test_a1Q9…', ''],
    ['ORD-1041', 'Oct 6, 08:11', 'hello@voxbloom.fm', 'Paid listing', P.vox, refunded ? 'o_refunded' : 'o_paid', 'pi_3QxY…', refunded ? 'Listing unpublished (no badge)' : ''],
    ['ORD-1040', 'Oct 5, 18:40', 'ops@debrief.so', 'Paid claim', P.debrief, 'o_paid', 'pi_3QwT…', ''],
    ['ORD-1039', 'Oct 4, 12:02', 'admin@keybazaar.shop', 'Paid listing', P.keyb, 'o_paid', 'pi_3QvM…', 'Rejected: prohibited'],
    ['ORD-1038', 'Oct 3, 20:30', 'team@kiddotutor.com', 'Paid listing', P.tutor, 'o_refunded', 'pi_3QuR…', 'Auto refund on reject'],
    ['ORD-1037', 'Oct 3, 09:12', 'sam@tidyinbox.app', 'Paid listing', P.tidy, 'o_failed', 'pi_3QtB…', 'Card declined'],
    ['ORD-1036', 'Oct 2, 15:47', 'hi@formsy.app', 'Paid listing', P.formsy, 'o_paid', 'pi_3QsK…', 'Badge passing']
  ];
  const tabs = Tabs([['all', 'All', 7], ['paid', 'Paid', refunded ? 3 : 4], ['refunded', 'Refunded', refunded ? 2 : 1], ['pending', 'Pending', 1], ['failed', 'Failed', 1]], 'all', { cls: 'max-w-full overflow-x-auto' });
  const table = DataTable(['Order', 'Date (UTC)', 'Customer', 'Kind', 'Item', 'Amount', 'Status', 'Stripe', ''], rows.map(r => ({ sel: (kind === 'list' || refunded) && r[0] === 'ORD-1041', cells: [`<span class="font-mono text-[13px]">${r[0]}</span>`, `<span class="text-muted-foreground">${r[1]}</span>`, r[2], r[3], `<div class="flex items-center gap-2">${logo(r[4], 22, { r: 'rounded-sm' })}<span>${r[4].name}</span></div>`, '<span class="tabular-nums">$49.00</span>', `<div class="flex flex-col items-start gap-1">${Status(r[5])}${r[7] ? `<span class="text-[11px] text-muted-foreground">${r[7]}</span>` : ''}</div>`, `<span class="font-mono text-xs text-muted-foreground">${r[6]}</span>`, RowMenu()] })), { right: [5, 8] });
  const menu = kind === 'list' ? `<div class="absolute right-3 top-[96px] z-30 w-48">${Menu([{ t: 'View in Stripe', icon: 'ext' }, { t: 'Copy order ID', icon: 'copy' }, { t: 'Open listing', icon: 'box' }, '-', { t: 'Refund…', icon: 'undo', danger: true, focus: true }])}</div>` : '';
  let overlay = '';
  if (kind === 'refund') overlay = Dialog({ alert: true, title: 'Refund $49.00 and unpublish Voxbloom?', desc: 'Refunds the full amount to hello@voxbloom.fm through Stripe. This can\u2019t be undone.', body: FieldGroup(`${kv([['Order', 'ORD-1041 · Paid listing · Voxbloom'], ['Amount', '$49.00 to the original payment method'], ['Listing now', Status('live_paid')], ['Listing after refund', `${Status('unlisted')} <span class="font-normal text-muted-foreground">URL returns 410</span>`]])}${Alert('warning', 'Voxbloom has no passing badge', 'A refunded listing stays up only if its badge is passing, as a free listing. Voxbloom has no badge, so it\u2019s unpublished.')}${Field({ label: 'Reason for the activity log', value: 'Customer asked for a refund within 24 hours.' })}`, 'gap-5'), footer: `${Button('Cancel', { v: 'outline' })}${Button('Refund and unpublish', { v: 'destructive' })}`, top: 'top-10' });
  if (kind === 'refundbadge') overlay = Dialog({ alert: true, title: 'Refund $49.00 for Formsy?', desc: 'Refunds the full amount to hi@formsy.app through Stripe. This can\u2019t be undone.', body: FieldGroup(`${kv([['Order', 'ORD-1036 · Paid listing · Formsy'], ['Amount', '$49.00 to the original payment method'], ['Listing now', `${Status('live')} ${Plan(true)}`], ['Listing after refund', `${Status('live')} ${Plan(false)}`]])}${Alert('success', 'Formsy keeps a passing badge', 'It stays live as a free listing and joins the weekly badge checks. If the badge later goes missing, the usual warning and recheck apply.')}${Field({ label: 'Reason for the activity log', value: 'Duplicate charge.' })}`, 'gap-5'), footer: `${Button('Cancel', { v: 'outline' })}${Button('Refund, keep live as free', { v: 'destructive' })}`, top: 'top-10' });
  if (refunded) overlay = Toast('Refunded $49.00 for ORD-1041', { desc: 'Voxbloom was unpublished (no passing badge). Logged under devin@serp.co.' });
  return shell('admin', 'orders', ['Admin', 'Orders'], `${adminTitle('Orders', 'Paid listings and paid claims. $49.00 USD, one-off.')}<div class="flex flex-col gap-4"><div class="flex flex-col gap-3 @lg:flex-row @lg:items-center @lg:justify-between">${tabs}${filterInput('', 'Filter by order, email, or product…')}</div><div class="relative">${table}${menu}</div>${TableFooter('7 orders', 1, 1)}</div>`, { overlay });
}

/* ============ 14. Admins ============ */
function admins(kind) {
  const last = kind === 'last';
  const rows = last ? [['devin@serp.co', true, 'May 16, 2026', 'Seeded by migration']] : [['devin@serp.co', true, 'May 16, 2026', 'Seeded by migration'], ['alex@serp.co', false, 'Oct 6, 2026', 'devin@serp.co']];
  const remove = () => last ? Tooltip('The last admin can’t be removed', Button('Remove', { v: 'outline', size: 'sm', disabled: true })) : Button('Remove', { v: 'outline', size: 'sm', cls: 'text-destructive' });
  const table = DataTable(['Email', 'Added', 'Added by', ''], rows.map(r => ({ cells: [`<div class="flex items-center gap-2">${Avatar(r[0].slice(0, 2).toUpperCase())}<span class="font-medium">${r[0]}</span>${r[1] ? Badge('You', { v: 'secondary' }) : ''}</div>`, `<span class="text-muted-foreground">${r[2]}</span>`, `<span class="text-muted-foreground">${r[3]}</span>`, `<div class="flex justify-end">${remove()}</div>`] })), { right: [3] });
  const add = Card({ title: 'Add an admin', desc: 'They get admin access the next time they sign in with this email.', content: `<div class="flex flex-col gap-3 @md:flex-row @md:items-start"><div class="flex-1">${Field({ label: 'Email', value: kind === 'adderr' ? 'alex@serp.co' : '', ph: 'name@serp.co', error: kind === 'adderr' ? 'alex@serp.co is already an admin.' : '' })}</div><div class="@md:pt-[30px]">${Button('Add admin', { icon: 'plus' })}</div></div>` });
  let overlay = '';
  if (kind === 'remove') overlay = Dialog({ alert: true, title: 'Remove alex@serp.co as an admin?', desc: 'They lose access to /admin right away. Their own account and listings stay as they are.', footer: `${Button('Cancel', { v: 'outline' })}${Button('Remove admin', { v: 'destructive' })}`, top: 'top-40' });
  return shell('admin', 'admins', ['Admin', 'Admins'], `${adminTitle('Admins', 'People on this list can open /admin after signing in. In production, Cloudflare Access also has to let them through.')}${last ? Alert('default', 'You’re the only admin', 'Add another admin before you can remove yourself, so someone can always review submissions.') : ''}${last ? `<div class="pt-10">${table}</div>` : table}${add}`, { overlay });
}
