/* ============ 1. /login (login-01 block: Card + Field) ============ */
function loginWrap(card) { return `<div class="flex w-full items-center justify-center p-6 @md:p-10"><div class="flex w-full max-w-sm flex-col gap-6">${card}</div></div>`; }
const loginTerms = FieldDescription(`By continuing you agree to the <a class="underline underline-offset-4">Terms of Service</a> and <a class="underline underline-offset-4">Privacy Policy</a>.`, 'text-center');

function loginEmail(o = {}) {
  return loginWrap(Card({
    title: 'Sign up or sign in', titleCls: 'text-xl',
    desc: 'Enter your email and we’ll send you a 6-digit code. New to SERP? The same code creates your account.',
    content: FieldGroup(`
      ${Alert('default', 'Your Quillmate draft is saved', 'Sign in to finish submitting it.')}
      ${Field({ label: 'Email', value: o.value, ph: 'you@company.com', focus: !o.limited })}
      ${o.limited ? Alert('warning', 'Too many code requests', 'You asked for 5 codes in the last hour. Try again in 38 minutes, or use the most recent code we sent.', { icon: 'clock' }) : ''}
      <div data-slot="field" class="flex flex-col gap-3">${Button('Email me a code', { full: true, disabled: o.limited })}${loginTerms}</div>`)
  }));
}
function loginCode(o = {}) {
  const err = { wrong: 'That code isn’t right. Check the most recent email and try again. 3 attempts left.', expired: 'This code has expired. Codes work for 10 minutes.', attempts: 'Too many incorrect codes. Request a new code to try again.' }[o.err];
  const resend = o.err ? `<a class="underline underline-offset-4">Send a new code</a>` : 'Resend in <span class="tabular-nums">0:42</span>';
  return loginWrap(Card({
    title: 'Check your email', titleCls: 'text-xl',
    desc: 'We sent a 6-digit code to <b class="font-medium text-foreground">maya@quillmate.app</b>. It expires in 10 minutes.',
    content: FieldGroup(`
      <div data-slot="field" data-invalid="${!!err}" class="flex flex-col gap-3">${FieldLabel('Code', { invalid: !!err })}${InputOTP(o.err ? '481902' : '481', { invalid: !!err, active: o.err ? -1 : 3 })}${err ? FieldError(err) : FieldDescription('From SERP Directory &lt;noreply@mail.serp.co&gt;. Check spam if it isn’t there in a minute.')}</div>
      <div data-slot="field" class="flex flex-col gap-3">${o.err === 'expired' || o.err === 'attempts' ? Button('Send a new code', { full: true }) : Button('Verify', { full: true })}${Button('Use a different email', { v: 'outline', full: true })}${FieldDescription(`Didn’t get it? ${resend}`, 'text-center')}</div>`)
  }));
}
function loginDone() {
  return loginWrap(Card({
    title: 'You’re signed in', titleCls: 'text-xl',
    desc: 'Signed in as <b class="font-medium text-foreground">maya@quillmate.app</b>. Taking you back to Submit, where your draft is waiting.',
    content: FieldGroup(`<div class="flex items-center gap-2 text-sm text-muted-foreground">${icon('loader', 'size-4 animate-spin')} Redirecting…</div><div data-slot="field" class="flex flex-col gap-3">${Button('Continue to Submit', { full: true, iconR: 'arrowR' })}${FieldDescription('Not you? <a class="underline underline-offset-4">Sign out</a>', 'text-center')}</div>`)
  }));
}

/* ============ 2. /submit (Card + FieldGroup; plan choice moved to 2b) ============ */
const PAGE_LONG = 'Quillmate is the AI copywriting assistant for busy founders and small marketing teams that turns rough product notes into landing pages, emails and ads in your own brand voice.';

function logoField(o = {}) {
  const p = P.quill;
  let body;
  if (o.mode === 'skeleton') body = `<div class="flex items-center gap-4">${Skeleton('size-16 rounded-lg')}<div class="flex-1 space-y-2">${Skeleton('h-4 w-40')}${Skeleton('h-8 w-64 max-w-full')}</div></div>`;
  else if (o.mode === 'prefilled') body = `<div class="flex flex-col gap-4 @sm:flex-row @sm:items-center">${logo(p, 64)}<div class="flex min-w-0 flex-col gap-3">${ToggleGroup(['Site icon', 'Social image', 'Upload'], 'Site icon')}</div></div>`;
  else if (o.mode === 'uploaded') body = `<div class="flex flex-col gap-4 @sm:flex-row @sm:items-center">${logo(p, 64)}<div class="flex flex-wrap items-center gap-2"><span class="text-sm font-medium">quillmate-logo.png</span><span class="text-sm text-muted-foreground">512 × 512 · 38 KB</span>${Button('Replace', { v: 'outline', size: 'sm', icon: 'upload' })}${Button('Remove', { v: 'ghost', size: 'sm' })}</div></div>`;
  else body = `<div class="flex flex-col gap-4 @sm:flex-row @sm:items-center"><div class="${cx('grid size-16 place-items-center rounded-lg border border-dashed text-muted-foreground', o.error ? 'border-destructive' : 'border-input')}">${icon('image', 'size-6')}</div>${Button('Upload image', { v: 'outline', size: 'sm', icon: 'upload' })}</div>`;
  const desc = o.mode === 'prefilled' ? 'Found on quillmate.app. Use it, pick the social image, or upload a square image (PNG, JPG, SVG or WebP, at least 128 × 128 px, up to 1 MB).' : 'Square PNG, JPG, SVG or WebP, at least 128 × 128 px, up to 1 MB.';
  return `<div data-slot="field" data-invalid="${!!o.error}" class="flex flex-col gap-3"><div class="flex items-center gap-2">${FieldLabel('Logo', { invalid: !!o.error })}${o.mode === 'prefilled' ? '<span class="ml-auto text-xs text-muted-foreground">From your site</span>' : ''}</div>${body}${o.error ? FieldError(o.error) : FieldDescription(desc)}</div>`;
}

function submitPage(o = {}) {
  const f = o.f || {};
  const dis = o.dup ? 'pointer-events-none select-none opacity-50' : '';
  const action = o.signedOut
    ? `<div class="flex w-full flex-col gap-3 @sm:flex-row @sm:items-center">${Button('Sign in and continue')}${FieldDescription('We’ll email you a 6-digit code. Your draft stays in this browser.')}</div>`
    : `<div class="flex w-full flex-col gap-3 @sm:flex-row @sm:items-center">${Button('Continue', { iconR: 'arrowR', disabled: !!o.dup })}${FieldDescription('Next, choose how to get listed.')}</div>`;
  const content = FieldGroup(`
    ${o.banner || ''}${o.summary || ''}
    ${Field({ label: 'Website URL', value: o.url ?? 'https://quillmate.app', mono: true, addon: o.addon, error: o.urlError, desc: o.urlDesc ?? 'We read the page title, description, and icon to fill in the rest. You can change everything.' })}
    ${o.dup || ''}
    <div class="${cx('flex flex-col gap-7', dis)}">
      ${o.prefillNote || ''}
      <div class="grid gap-7 @md:grid-cols-2">${Field({ label: 'Name', value: f.name, ph: 'Example product', error: f.nameErr, skeleton: o.loading, tag: f.nameTag })}${Field({ label: 'Primary category', select: true, value: f.cat, error: f.catErr, desc: f.catDesc })}</div>
      ${Field({ label: 'Short description', area: true, value: f.short, ph: 'One sentence on what it does and who it is for.', max: 160, error: f.shortErr, skeleton: o.loading, desc: 'Shown on cards and in search results.', tag: f.shortTag })}
      ${logoField({ mode: o.loading ? 'skeleton' : f.logo, error: f.logoErr })}
      ${Field({ label: 'Long description', opt: true, area: true, tall: true, value: f.long, ph: 'Markdown supported. What makes it useful, who it is for, how it works.', desc: 'Shown on your listing page. FAQs and links can be added from your account later.' })}
    </div>`);
  return `<section class="mx-auto w-full max-w-2xl px-4 py-10 @md:py-14">${Card({
    title: '<h1 class="text-2xl font-semibold tracking-tight">Submit a product</h1>', desc: 'Every listing is reviewed by the SERP team. Tell us about your product first.',
    content, footer: action, footerCls: 'border-t pt-6'
  })}</section>`;
}
const prefilled = { name: 'Quillmate', nameTag: 'From og:site_name', cat: '', catDesc: 'Pick the closest match. We don’t fill this in.', short: P.quill.short, shortTag: 'From meta description', logo: 'prefilled', long: '' };

function dupListed() {
  const b = P.brief;
  return Alert('default', 'Brieflow is already listed on SERP', `<p>We match on the domain, so brieflow.ai/pricing counts as brieflow.ai. If it’s your product, claim the listing to manage it.</p><div class="mt-2 w-full">${Item({ media: logo(b, 40, { r: 'rounded-sm' }), title: 'Brieflow', desc: `${b.cat} · /products/brieflow.ai/`, cls: 'bg-background' })}</div>`, { actions: `${Button('Claim this listing', { size: 'sm', icon: 'verified' })}${Button('View listing', { size: 'sm', v: 'outline', iconR: 'ext' })}` });
}
function dupPending(mine) {
  return mine
    ? Alert('info', 'You already submitted clipwise.video', 'It’s in your account, waiting for you to finish the badge step.', { actions: Button('Open submission', { size: 'sm', iconR: 'arrowR' }) })
    : Alert('warning', 'brieflow.ai is already in review', 'Someone else submitted this domain. If brieflow.ai is yours, message us and we\u2019ll sort it out.', { actions: Button('Message us', { size: 'sm', v: 'outline', icon: 'msg' }) });
}

/* ============ 2b. Choose free or paid (new, Revision 2) ============ */
function summaryItem(o = {}) {
  const p = P.quill;
  return Item({ media: logo(p, 40, { r: 'rounded-sm' }), title: `${p.name} <span class="font-normal text-muted-foreground">${p.domain} · ${p.cat}</span>`, desc: p.short, actions: o.noEdit ? '' : Button('Edit details', { v: 'ghost', size: 'sm', icon: 'pencil' }) });
}
function planCards() {
  const free = Card({
    desc: 'Install the badge (free)', title: 'Free', descFirst: true, titleCls: 'text-3xl font-semibold tabular-nums',
    action: Badge('Reviewed first', { v: 'outline' }),
    content: checkList(['Add the Featured on SERP badge to quillmate.app with a dofollow link to your listing', 'We verify it, then a reviewer looks at your listing', 'Keep the badge up: we check it every week']),
    footer: Button('Get the badge code', { full: true, iconR: 'arrowR' }), footerCls: 'mt-auto'
  });
  const paid = Card({
    desc: 'Skip the badge: $49 one-off', title: '$49', descFirst: true, titleCls: 'text-3xl font-semibold tabular-nums',
    action: Badge('Live after checks', { v: 'outline' }),
    content: checkList(['Live right after payment when automatic checks pass', 'Still reviewed. Full refund if rejected, except prohibited content', 'Badge optional and never checked. One-off, no subscription']),
    footer: `<div class="flex w-full flex-col gap-2">${Button('Pay $49 and go live', { full: true, iconR: 'arrowR' })}<p class="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">${icon('lock', 'size-3')} Secure checkout by Stripe</p></div>`, footerCls: 'mt-auto'
  });
  return `<div class="grid grid-cols-1 gap-4 @md:grid-cols-2 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card">${free}${paid}</div>`;
}
function choosePlan(kind = 'default') {
  if (kind === 'later') {
    return `<section class="mx-auto w-full max-w-xl px-4 py-12">${Card({
      title: '<h1 class="text-2xl font-semibold tracking-tight">Quillmate is saved</h1>',
      desc: 'You can leave now. Nothing is reviewed or published until you choose free or paid.',
      content: `<div class="flex flex-col gap-4">${summaryItem({ noEdit: true })}<div class="flex items-center gap-2 text-sm"><span class="text-muted-foreground">Status</span>${Status('plan_draft')}</div>${Alert('default', 'Pick it up from your account', 'It\u2019s listed under Submissions as \u201cDraft \u2013 choose a plan\u201d, with a Continue button that brings you back to this choice.', { icon: 'info' })}</div>`,
      footer: `<div class="flex w-full flex-col gap-2 @sm:flex-row">${Button('Go to my account')}${Button('Choose now', { v: 'outline' })}</div>`
    })}</section>`;
  }
  const resumed = kind === 'resumed';
  return `<section class="mx-auto w-full max-w-3xl px-4 py-10 @md:py-14"><div class="flex flex-col gap-6">
    ${StepProgress(2, 4, 'How to get listed')}
    ${resumed ? Alert('info', 'Welcome back', 'Quillmate is saved but not in the review queue yet. Pick an option to continue.') : Alert('success', 'Details saved', 'Signed in as maya@quillmate.app. You can change the details until it’s reviewed.')}
    ${summaryItem()}
    <div class="space-y-1"><h1 class="text-2xl font-semibold tracking-tight">Choose how to get listed</h1><p class="text-sm text-muted-foreground">Both options are reviewed by the SERP team. You can switch from free to paid later.</p></div>
    ${planCards()}
    <p class="text-center text-sm text-muted-foreground">Not ready to decide? ${Button('Decide later', { v: 'link', size: 'link' })}</p>
  </div></section>`;
}

/* ============ 3. Badge step ============ */
function badgeCard(theme) {
  const copy = Button(theme === 'light' ? 'Copied' : 'Copy code', { v: 'outline', size: 'sm', icon: theme === 'light' ? 'check' : 'copy' });
  return Card({
    title: `${theme === 'light' ? 'Light' : 'Dark'} badge`, cls: 'min-w-0 gap-4',
    action: theme === 'light' ? Tooltip('Copied to clipboard', copy) : copy,
    content: `<div class="flex flex-col gap-3">${badgeSvg(theme, 180)}<div data-slot="textarea" class="w-full overflow-x-auto rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed shadow-xs dark:bg-input/30"><pre class="whitespace-pre">${esc(embedCode(P.quill, theme))}</pre></div></div>`
  });
}
function badgeStep(o = {}) {
  const p = P.quill;
  const site = 'https://quillmate.app/';
  const left = o.left ?? 10;
  const R = {
    missing: Alert('warning', 'Page reached, badge not found', `We loaded ${site}, but the badge wasn’t in the HTML it returned. Publish the snippet on that exact URL, then check again.`),
    nofollow: Alert('warning', 'Badge found, but the link is nofollow', `Remove <code>nofollow</code> from the badge link, publish the change, then check again.<div class="mt-2 w-full overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-[11px] text-foreground">&lt;a href="${listingUrl(p)}" rel="<span class="rounded bg-red-500/15 px-0.5 text-red-700 line-through dark:text-red-400">nofollow</span> noopener"&gt;</div>`),
    wrong: Alert('warning', 'Badge found, but it links elsewhere', `Your badge links to <b>${SITE}/</b>. It has to link to your listing: <b>${listingUrl(p)}</b>. Replace it with the snippet above, publish, then check again.`),
    unreach: Alert('default', 'We couldn’t reach quillmate.app', 'The site didn’t respond within 8 seconds. Make sure the page is public and that a firewall or bot protection isn’t blocking our checker. This didn’t use up a check.', { icon: 'globe' }),
    cooldown: Alert('default', 'One check every 30 seconds', 'You can check again in <b class="tabular-nums text-foreground">0:24</b>.', { icon: 'clock' }),
    limit: Alert('destructive', 'Automatic checks are paused', 'None of your last 10 checks found a working badge. Your submission is saved. Message us and we\u2019ll look at it with you, or skip the badge for a $49 one-off payment.', { actions: `${Button('Message us', { size: 'sm', v: 'outline', icon: 'msg' })}${Button('Skip the badge: $49 one-off', { size: 'sm', v: 'outline' })}` })
  };
  let verify = Button('Verify badge', { icon: 'shield' });
  if (o.r === 'checking') verify = Button('Checking…', { loading: true });
  if (o.r === 'cooldown') verify = Button('Check again in 0:24', { icon: 'clock', disabled: true });
  if (o.r === 'limit') verify = Button('Verify badge', { icon: 'shield', disabled: true });

  if (o.r === 'pass') {
    return `<section class="mx-auto w-full max-w-3xl px-4 py-10 @md:py-14"><div class="flex flex-col gap-6">${StepProgress(4, 4, 'Review')}
      ${Alert('success', 'Badge verified', `We found the badge on ${site} with a dofollow link to your listing.`)}
      ${Card({ title: '<h1 class="text-2xl font-semibold tracking-tight">Quillmate is in the review queue</h1>', desc: 'A reviewer looks at it next. We’ll email maya@quillmate.app with the result.', content: `<div class="grid gap-4 @md:grid-cols-2">${Item({ v: 'muted', media: `<div class="flex size-8 items-center justify-center rounded-sm border bg-muted">${icon('shield')}</div>`, title: 'Keep the badge up', desc: 'We check it every week. If it goes missing, we email you and check again about 24 hours later.' })}${Item({ v: 'muted', media: `<div class="flex size-8 items-center justify-center rounded-sm border bg-muted">${icon('plus')}</div>`, title: 'Add FAQs and links', desc: 'From your account while the listing is in review.' })}</div>`, footer: Button('Go to my account', { iconR: 'arrowR' }) })}
    </div></section>`;
  }
  return `<section class="mx-auto w-full max-w-3xl px-4 py-10 @md:py-14"><div class="flex flex-col gap-6">
    ${StepProgress(3, 4, 'Badge')}
    <div class="flex items-start gap-4">${logo(p, 48)}<div><h1 class="text-2xl font-semibold tracking-tight">Add the badge to quillmate.app</h1><p class="mt-1 text-sm text-muted-foreground">Paste a snippet into the HTML of <b class="font-medium text-foreground">${site}</b>. The footer works well. Keep the link dofollow: don’t add <code class="rounded bg-muted px-1 font-mono text-xs">rel="nofollow"</code>.</p></div></div>
    <div class="grid grid-cols-1 gap-4 @md:grid-cols-2">${badgeCard('light')}${badgeCard('dark')}</div>
    <p class="break-all text-xs text-muted-foreground">Both badges link to your future listing: ${listingUrl(p)}</p>
    ${Card({ title: 'Verify the badge', desc: `We load ${site} and look for the badge and its dofollow link.`, action: verify, cls: 'gap-4',
      content: `<div class="flex flex-col gap-3">${R[o.r] || ''}<p class="text-xs text-muted-foreground"><b class="tabular-nums text-foreground">${left} of 10</b> checks left · one every 30 seconds · connection problems don’t use up a check</p></div>` })}
    <p class="text-sm text-muted-foreground">You can leave this page and finish later from your account. Rather not add a badge? ${Button('Skip the badge: $49 one-off', { v: 'link', size: 'link' })}</p>
  </div></section>`;
}

/* ============ 4. Paid checkout ============ */
function orderItem(o = {}) {
  return Item({ media: logo(P.quill, 40, { r: 'rounded-sm' }), title: 'Paid listing: Quillmate', desc: 'One-off payment, USD. The listing is permanent.', actions: `<div class="flex flex-col items-end gap-1"><span class="text-base font-semibold tabular-nums">$49.00</span>${o.status || ''}</div>` });
}
function checkoutHandoff() {
  return `<section class="mx-auto w-full max-w-xl px-4 py-12">${Card({
    title: `<span class="flex items-center gap-2 text-2xl font-semibold tracking-tight">${icon('loader', 'size-5 animate-spin')} Taking you to Stripe</span>`,
    desc: 'You’ll pay on Stripe’s checkout page and come straight back here.',
    content: `<div class="flex flex-col gap-6">${orderItem()}<div><p class="text-sm font-medium">After you pay</p><ol class="mt-3 grid gap-3 text-sm">${[
      ['We run automatic checks', 'The URL is public and loads, isn’t already listed, and passes our safe-fetch rules.'],
      ['Checks pass: Quillmate goes live', 'Within about a minute, at /products/quillmate.app/.'],
      ['A reviewer still looks at it', 'If it’s rejected for anything other than prohibited content, you get a full refund automatically.']
    ].map(([t, d], i) => `<li class="flex gap-3"><span class="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium">${i + 1}</span><div><p class="font-medium">${t}</p><p class="text-muted-foreground">${d}</p></div></li>`).join('')}</ol></div></div>`,
    footer: `<div class="flex w-full flex-col gap-2 @sm:flex-row">${Button('Continue to checkout', { iconR: 'ext' })}${Button('Back to options', { v: 'ghost', icon: 'arrowL' })}</div>`
  })}</section>`;
}
function stripeWire() {
  const bar = (w, h = 'h-9') => `<div class="${h} rounded-md border border-dashed border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900" style="width:${w}"></div>`;
  return `<div class="relative min-h-[620px] bg-zinc-50 dark:bg-zinc-950">
    <div class="absolute left-1/2 top-4 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">Stripe-hosted page · wireframe for context, not our UI</div>
    <div class="mx-auto grid max-w-4xl gap-10 px-6 pb-12 pt-20 @md:grid-cols-2">
      <div class="space-y-4"><p class="flex items-center gap-1 text-sm font-semibold text-zinc-500">${icon('arrowL', 'size-4')} SERP</p><p class="text-sm text-zinc-500">Paid listing: Quillmate</p><p class="text-4xl font-bold tabular-nums">$49.00</p><p class="text-xs text-zinc-500">One-off payment</p></div>
      <div class="space-y-4"><p class="text-sm font-medium text-zinc-500">Email</p>${bar('100%')}<p class="text-sm font-medium text-zinc-500">Card information</p>${bar('100%', 'h-24')}<p class="text-sm font-medium text-zinc-500">Cardholder name</p>${bar('100%')}<div class="h-11 rounded-md bg-zinc-300 text-center text-sm font-semibold leading-[44px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Pay $49.00</div></div>
    </div></div>`;
}
function checkoutResult(kind) {
  const p = P.quill;
  const order = st => kv([['Order', '<span class="font-mono">ORD-1042</span>'], ['Amount', '$49.00 USD, one-off'], ['Status', st], ['Receipt', 'Emailed to maya@quillmate.app by Stripe']]);
  const wrap = inner => `<section class="mx-auto w-full max-w-xl px-4 py-12"><div class="flex flex-col gap-6">${inner}</div></section>`;
  if (kind === 'confirming') return wrap(Card({ title: `<span class="flex items-center gap-2 text-xl font-semibold">${icon('loader', 'size-5 animate-spin')} Confirming your payment…</span>`, desc: 'This usually takes a few seconds. You can keep this page open or check your account later.', content: orderItem() }));
  if (kind === 'live') return wrap(`${Alert('success', 'Payment received', 'Thanks. Quillmate passed our automatic checks.')}
    ${Card({ title: '<h1 class="text-2xl font-semibold tracking-tight">Quillmate is live on SERP</h1>', desc: `<span class="break-all">${listingUrl(p)}</span>`, content: `<div class="flex flex-col gap-6">${Alert('info', 'Still in review', 'Our team reviews every paid listing. If we reject Quillmate for anything other than prohibited content, you get a full refund automatically.')}${order(Status('o_paid'))}</div>`, footer: `<div class="flex w-full flex-col gap-2 @sm:flex-row">${Button('View your listing', { iconR: 'ext' })}${Button('Go to my account', { v: 'outline' })}</div>` })}
    <p class="text-center text-sm text-muted-foreground">The badge is optional for paid listings. ${Button('Get the badge code', { v: 'link', size: 'link' })}</p>`);
  if (kind === 'checksfail') return wrap(`${Alert('warning', 'Payment received, waiting for review', 'Our checks couldn’t load https://quillmate.app/ (no response within 8 seconds).')}
    ${Card({ title: '<h1 class="text-2xl font-semibold tracking-tight">Quillmate goes live after review</h1>', desc: 'A reviewer will look at it before it’s published. You don’t need to do anything. If it’s rejected for anything other than prohibited content, you get a full refund automatically.', content: order(Status('o_paid')), footer: Button('Go to my account') })}`);
  if (kind === 'cancelled') return wrap(Card({ title: '<h1 class="text-2xl font-semibold tracking-tight">Checkout cancelled</h1>', desc: 'You weren’t charged. Quillmate is saved in your account, so you can pick it up any time.', content: orderItem({ status: Status('draft') }), footer: `<div class="flex w-full flex-col gap-2 @sm:flex-row">${Button('Return to checkout', { iconR: 'arrowR' })}${Button('Back to options', { v: 'outline' })}</div>` }));
  if (kind === 'failed') return wrap(`${Alert('destructive', 'Payment didn’t go through', 'Stripe declined the payment, so you weren’t charged.')}
    ${Card({ title: '<h1 class="text-2xl font-semibold tracking-tight">Try the payment again</h1>', desc: 'Quillmate is saved. Nothing is published until a payment succeeds or the badge is verified.', content: `<div class="flex flex-col gap-3">${orderItem({ status: Status('o_failed') })}<p class="text-xs text-muted-foreground">Order <span class="font-mono">ORD-1043</span></p></div>`, footer: `<div class="flex w-full flex-col gap-2 @sm:flex-row">${Button('Try again', { icon: 'refresh' })}${Button('Back to options', { v: 'outline' })}</div>` })}`);
  return '';
}
