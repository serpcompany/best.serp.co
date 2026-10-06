/* ============ 17. /admin/inbox (Data Table + Message/Bubble + InputGroup composer) ============ */
const ITHREADS = [
  ['maya@quillmate.app', 'MO', P.page, 'Submission', 'Changes requested', 'Thanks. Is “Builds a small-business website from a short questionnaire” OK as the short description?', '2 h', true],
  ['priya@brieflow.ai', 'PB', P.brief, 'Claim', 'Already owned', 'I’m the CEO of Brieflow. Our former marketing lead claimed the listing before leaving…', '3 h', true],
  ['nina@clipwise.video', 'NC', P.clip, 'Submission', 'Badge check blocked', 'Our firewall blocks bots. Which user agent does your checker use?', '5 h', true],
  ['maya@quillmate.app', 'MO', P.quill, 'Submission', 'Demo video before review?', 'Can I add a demo video before it’s reviewed?', '6 h', false],
  ['maya@quillmate.app', 'MO', GENERAL, 'General', 'Receipt with company name', 'Can I get a receipt with my company name on it?', '1 d', false],
  ['ops@debrief.so', 'OD', P.debrief, 'Listing', 'Pricing link moved', 'Our pricing page moved to /plans. Can you update the link?', '2 d', false]
];
function inboxTable(o = {}) {
  let rows = ITHREADS;
  if (o.filter) rows = rows.filter(r => r[7] && r[3] === 'Claim');
  const typeFacet = `<div class="relative inline-flex">${Facet('Type', o.filter ? ['Claim'] : [])}${o.filter ? `<div class="absolute right-0 top-full z-50 mt-1 @md:left-0 @md:right-auto">${CommandList('Type', [['Submission', 3, false], ['Listing', 1, false], ['Claim', 1, true], ['General', 1, false]])}</div>` : ''}</div>`;
  const toolbar = `<div class="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">${Tabs([['all', 'All', 6], ['unread', 'Unread', 3]], o.filter ? 'unread' : 'all')}<div class="flex flex-wrap items-center gap-2">${filterInput('', 'Filter by email or subject…')}${typeFacet}${o.filter ? Button('Reset', { v: 'ghost', size: 'sm', iconR: 'x' }) : ''}</div></div>`;
  const table = DataTable(['', 'From', 'About', 'Type', 'Last message', 'Updated'], rows.map(r => ({ cells: [r[7] ? '<span class="block size-2 rounded-full bg-primary" aria-label="Unread"></span>' : '', `<div class="flex items-center gap-2">${Avatar(r[1])}<span class="${r[7] ? 'font-semibold' : ''}">${r[0]}</span></div>`, `<div class="flex items-center gap-2">${logo(r[2], 22, { r: 'rounded-sm' })}<span class="${r[7] ? 'font-semibold' : 'font-medium'}">${r[2].name}: ${r[4]}</span></div>`, typeBadge(r[3]), `<span class="block max-w-[260px] truncate text-muted-foreground">${r[5]}</span>`, `<span class="text-muted-foreground">${r[6]}</span>`] })));
  return `<div class="flex flex-col gap-4">${toolbar}${table}${TableFooter(`${rows.length} of 6 conversations`, 1, 1)}</div>`;
}
function adminInbox(kind) {
  const crumbs = ['Admin', 'Inbox'];
  if (kind === 'empty') return shell('admin', 'inbox', crumbs, `${adminTitle('Inbox', 'Conversations with submitters and owners')}${Empty({ icon: 'msg', title: 'No conversations', desc: 'Messages from submitters, owners, and claimers show up here. Your notes on change requests and rejections are posted to their conversations too.', cls: 'min-h-[380px]' })}`);
  if (kind === 'thread') {
    const msgs = [
      Msg({ avatar: `<span class="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">${icon('info')}</span>`, header: 'System · Tue, Oct 6, 08:55', block: Alert('default', 'Claim refused: Brieflow already has an owner', 'priya@brieflow.ai tried to claim Brieflow. It’s owned by jordan@brieflow.ai (badge claim, Sep 3).', { icon: 'info' }) }),
      Msg({ avatar: Avatar('PB'), header: 'priya@brieflow.ai · Tue, Oct 6, 08:58', body: 'I’m the CEO of Brieflow. Jordan ran marketing and left in August, and claimed the listing with their brieflow.ai address before leaving. Can you move it to me? I can confirm priya@brieflow.ai.' })
    ];
    const conv = Card({ title: 'Conversation', desc: 'Claim · opened Tue, Oct 6, 08:58', cls: 'gap-4', action: Button('Mark as unread', { v: 'ghost', size: 'sm' }),
      content: `<div class="flex flex-col gap-6">${msgs.join('')}</div>`,
      footer: `<div class="w-full">${Composer({ value: 'Thanks, Priya. I’ll confirm with Jordan first and move the listing to you if they agree.', focus: true, send: 'Reply', hint: 'Sent as the SERP team.', desc: 'Priya gets an email saying there’s a new message. The email doesn’t include your reply.' })}</div>`, footerCls: 'border-t pt-6' });
    const side = `${Card({ title: 'About', cls: 'gap-4', content: `<div class="flex flex-col gap-3">${Item({ media: logo(P.brief, 40, { r: 'rounded-sm' }), title: `Brieflow ${Status('live')}`, desc: 'Owner jordan@brieflow.ai · badge claim', cls: '!p-0 !border-0' })}<div class="flex flex-wrap gap-2">${Button('Open listing', { v: 'outline', size: 'sm', iconR: 'arrowR' })}${Button('Transfer owner', { v: 'outline', size: 'sm', icon: 'users' })}</div></div>` })}
      ${Card({ title: 'From', cls: 'gap-4', content: Item({ media: Avatar('PB'), title: 'priya@brieflow.ai', desc: 'Account since Oct 6, 2026 · no other conversations', cls: '!p-0 !border-0' }) })}`;
    return shell('admin', 'inbox', [...crumbs, 'Brieflow claim'], `${pageHead(P.brief, 'Brieflow: already owned', typeBadge('Claim'), 'priya@brieflow.ai · /admin/inbox/t_3hq7/')}<div class="grid gap-6 @xl:grid-cols-[minmax(0,1fr)_300px]"><div class="min-w-0">${conv}</div><div class="flex flex-col gap-4">${side}</div></div>`);
  }
  return shell('admin', 'inbox', crumbs, `${adminTitle('Inbox', '3 unread · conversations with submitters, owners, and claimers')}${inboxTable({ filter: kind === 'filtered' })}`);
}
/* Thread panels for 11 and 12 */
function reviewThreadPanel() {
  return Card({ title: 'Conversation', desc: 'with maya@quillmate.app · 1 unread', cls: 'gap-4', action: Button('Open', { v: 'ghost', size: 'sm', iconR: 'arrowR' }),
    content: `<div class="flex flex-col gap-4">${Msg({ avatar: Avatar('MO'), header: 'Maya · Tue, Oct 6, 10:51', body: 'Can I add a demo video before it’s reviewed? It’s a 90-second walkthrough.' })}${Composer({ ph: 'Reply to Maya…', send: 'Reply', hint: ' ' })}</div>` });
}
function listingThreadPanel() {
  return Card({ title: 'Conversations', desc: 'About Brieflow', cls: 'gap-4',
    content: `<div class="flex flex-col gap-2">${Item({ media: Avatar('PB'), title: `priya@brieflow.ai <span class="size-2 rounded-full bg-primary"></span>`, desc: 'Claim: already owned · 3 h', actions: Button('Open', { v: 'outline', size: 'sm' }), cls: '!p-3' })}${Item({ media: Avatar('JL'), title: 'jordan@brieflow.ai', desc: 'Listing: badge back up · Sep 22', actions: Button('Open', { v: 'outline', size: 'sm' }), cls: '!p-3' })}</div>` });
}
