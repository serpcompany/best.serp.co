/* ============ 16. /account Messages (sidebar-09 inbox list + Message/Bubble + InputGroup composer) ============ */
const GENERAL = { name: 'General', letter: '?', color: '#71717a' };
const THREADS = [
  { id: 'pagecraft', p: P.page, type: 'Submission', subject: 'Changes requested', date: 'Oct 5', teaser: 'That works: it says what the product does. Upload a square logo too, then resubmit.', unread: true },
  { id: 'ledgerly', p: P.ledger, type: 'Listing', subject: 'Badge recheck', date: 'Oct 6', teaser: 'We rechecked ledgerly.app after your fix. The badge passes now.', unread: true },
  { id: 'quillmate', p: P.quill, type: 'Submission', subject: 'Demo video before review?', date: 'Oct 6', teaser: 'You: Can I add a demo video before it’s reviewed?' },
  { id: 'receipt', p: GENERAL, type: 'General', subject: 'Receipt with company name', date: 'Oct 6', teaser: 'Stripe emailed your receipt. Open it to add a company name.' },
  { id: 'promptdeck', p: P.prompt, type: 'Submission', subject: 'Rejected', date: 'Oct 2', teaser: 'Reason: promptdeck.io shows a domain-parking page with no product.' }
];
const typeBadge = t => Badge(t, { v: 'outline', cls: 'text-muted-foreground' });
const me = () => Avatar('MO');

function threadList(sel, o = {}) {
  const items = THREADS.map(t => `<a class="${cx('flex flex-col items-start gap-2 border-b p-4 text-sm leading-tight last:border-b-0 hover:bg-accent hover:text-accent-foreground', t.id === sel && 'bg-accent text-accent-foreground')}">
    <div class="flex w-full items-center gap-2">${t.unread ? '<span class="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread"></span>' : ''}${logo(t.p, 20, { r: 'rounded-sm' })}<span class="${cx('truncate', t.unread && 'font-semibold')}">${t.p.name}</span>${typeBadge(t.type)}<span class="ml-auto shrink-0 text-xs text-muted-foreground">${t.date}</span></div>
    <span class="${t.unread ? 'font-semibold' : 'font-medium'}">${t.subject}</span>
    <span class="line-clamp-2 text-xs text-muted-foreground">${t.teaser}</span>
  </a>`).join('');
  return `<div class="${cx('flex w-full flex-col @lg:w-80 @lg:shrink-0 @lg:border-r', o.hide && 'hidden @lg:flex')}">
    <div class="flex flex-col gap-3.5 border-b p-4">
      <div class="flex w-full items-center justify-between gap-2"><div class="text-base font-medium text-foreground">Messages</div><div class="flex items-center gap-3"><label class="flex items-center gap-2 text-sm">Unread ${Switch(false)}</label>${Button('', { v: 'outline', size: 'iconSm', icon: 'plus', sr: 'New message' })}</div></div>
      <div data-slot="sidebar-input">${inputBox({ ph: 'Search messages…' }).replace('h-9', 'h-8')}</div>
    </div>
    <div class="flex flex-col">${items}</div>
  </div>`;
}

function threadMessages(id, o = {}) {
  if (id === 'pagecraft') {
    return [
      Msg({ avatar: teamAvatar(), header: 'SERP team · Sun, Oct 4, 15:02', block: Alert('warning', 'Changes requested', '<p>The short description reads like an ad (#1 best, 10x faster). Describe what Pagecraft does in plain terms. Also replace the logo: the current one is a screenshot of your homepage.</p>', { icon: 'msg', actions: Button('Edit and resubmit', { size: 'sm' }) }) }),
      Msg({ align: 'end', avatar: me(), header: 'You · Sun, Oct 4, 16:10', body: 'Thanks. Is “Builds a small-business website from a short questionnaire” OK as the short description, or is that still too salesy?' }),
      sepLabel('Today'),
      Msg({ avatar: teamAvatar(), header: `SERP team · Mon, Oct 5, 09:02 ${Badge('New', { v: 'default' })}`, body: 'That works: it says what the product does. Upload a square logo too, then resubmit.' })
    ];
  }
  // quillmate thread
  const msgs = [
    Msg({ align: 'end', avatar: me(), header: 'You · Tue, Oct 6, 10:51', body: 'Can I add a demo video before it’s reviewed? It’s a 90-second walkthrough on YouTube.', footer: 'Seen by the SERP team' })
  ];
  if (o.sending) msgs.push(Msg({ align: 'end', avatar: me(), header: 'You · now', body: 'Also, the logo on the preview looks small. Is 512 × 512 OK?', footer: `${icon('loader', 'size-3 animate-spin')} Sending…`, pending: true }));
  return msgs;
}
const sepLabel = t => `<div data-slot="field-separator" class="relative -my-2 h-5 text-sm"><div class="absolute inset-0 top-1/2 h-px bg-border"></div><span data-slot="field-separator-content" class="relative mx-auto block w-fit bg-background px-2 text-xs text-muted-foreground">${t}</span></div>`;

function threadView(id, o = {}) {
  const t = THREADS.find(x => x.id === id);
  const head = `<div class="flex items-center gap-3 border-b p-4">${Button('', { v: 'ghost', size: 'iconSm', icon: 'arrowL', sr: 'Back to messages', cls: '-ml-1 @lg:hidden' })}${logo(t.p, 32, { r: 'rounded-sm' })}<div class="min-w-0 flex-1"><p class="truncate font-medium">${t.p.name}: ${t.subject.toLowerCase()}</p><div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">${typeBadge(t.type)}${t.p.domain || ''}${id === 'pagecraft' ? Status('changes') : id === 'quillmate' ? Status('in_review') : ''}</div></div>${Button(t.type === 'Listing' ? 'Open listing' : 'Open submission', { v: 'outline', size: 'sm', iconR: 'arrowR', cls: 'hidden @sm:flex' })}</div>`;
  let composer;
  if (o.sending) composer = Composer({ disabled: true, sending: true, desc: 'We’ll email you when the team replies.' });
  else if (o.err === 'rate') composer = `${Alert('destructive', 'You’re sending messages too quickly', 'Wait about 2 minutes, then send again. Your draft is kept.', { icon: 'clock' })}${Composer({ value: 'One more thing: can the listing mention our free plan?', disabled: true })}`;
  else if (o.err === 'long') composer = Composer({ value: 'Here is everything about our roadmap, pricing history, the full changelog since 2021, and a long list of integrations we plan to ship next quarter, including…', count: 2148, invalid: true, error: 'Keep it under 2,000 characters. It’s 2,148 now.' });
  else if (id === 'quillmate') composer = Composer({ value: 'Also, the logo on the preview looks small. Is 512 × 512 OK?', focus: true, desc: 'We’ll email you when the team replies.' });
  else composer = Composer({ desc: 'We’ll email you when the team replies.' });
  return `<div class="flex min-w-0 flex-1 flex-col">${head}<div data-slot="message-scroller-content" class="flex flex-1 flex-col gap-6 p-4 @lg:p-6">${threadMessages(id, o).join('')}</div><div class="border-t p-4">${composer}</div></div>`;
}

function messagesPage(kind) {
  const crumbs = ['Account', 'Messages'];
  if (kind === 'empty') {
    return shell('account', 'messages', crumbs, Empty({ icon: 'msg', title: 'No messages yet', desc: 'Questions about a submission or a listing? Start a conversation and the SERP team replies here. We email you when they do.', actions: Button('New message', { icon: 'plus' }), cls: 'min-h-[460px]' }));
  }
  if (kind === 'mobile') {
    const phone = (label, inner) => `<div class="flex w-full max-w-[390px] flex-col gap-2"><p class="text-center text-xs font-medium text-muted-foreground">${label}</p><div class="@container overflow-hidden rounded-xl border bg-background shadow-sm">${inner}</div></div>`;
    return `<div class="flex flex-col items-center gap-6 bg-muted/40 p-6 @lg:flex-row @lg:items-start @lg:justify-center">${phone('Phone: list', shell('account', 'messages', crumbs, `<div class="flex flex-1">${threadList('')}</div>`, { flush: true }))}${phone('Phone: thread (back arrow returns to the list)', shell('account', 'messages', [...crumbs, 'Pagecraft'], `<div class="flex flex-1">${threadView('pagecraft')}</div>`, { flush: true }))}</div>`;
  }
  const id = kind === 'list' || kind === 'new' ? null : kind === 'changes' ? 'pagecraft' : 'quillmate';
  const right = id
    ? threadView(id, { sending: kind === 'sending', err: kind === 'rate' ? 'rate' : kind === 'long' ? 'long' : '' })
    : `<div class="hidden flex-1 p-6 @lg:flex">${Empty({ icon: 'msg', title: 'Select a conversation', desc: 'Or start a new one about a submission, a listing, a claim, or anything else.', actions: Button('New message', { v: 'outline', icon: 'plus' }) })}</div>`;
  const overlay = kind === 'new' ? Dialog({
    title: 'Message the SERP team', desc: 'Started from “Message us” on the Brieflow claim dialog.',
    body: FieldGroup(`${Field({ label: 'About', select: true, value: 'Claim: Brieflow (brieflow.ai)', desc: 'Submission, listing, claim, or general.' })}${Field({ label: 'Message', area: true, value: 'I’m the CEO of Brieflow. Our former marketing lead claimed the listing with a brieflow.ai address before leaving in August. Can you move it to me? I can confirm priya@brieflow.ai.' })}`, 'gap-6'),
    footer: `${Button('Cancel', { v: 'outline' })}${Button('Send', { iconR: 'arrowR' })}`, top: 'top-16', drawer: true
  }) : '';
  return shell('account', 'messages', id ? [...crumbs, THREADS.find(x => x.id === id).p.name] : crumbs, `<div class="flex min-h-[680px] flex-1">${threadList(id, { hide: !!id })}${right}</div>`, { flush: true, overlay, clip: kind === 'new' });
}
