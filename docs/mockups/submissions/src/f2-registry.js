/* ============ screen registry ============ */
const DOC = 'https://ui.shadcn.com/docs/components/';
const NAMES = { message: 'Message', bubble: 'Bubble', switch: 'Switch', card: 'Card', field: 'Field', input: 'Input', 'input-otp': 'InputOTP', button: 'Button', alert: 'Alert', badge: 'Badge', select: 'Select', textarea: 'Textarea', skeleton: 'Skeleton', 'toggle-group': 'ToggleGroup', item: 'Item', 'input-group': 'InputGroup', progress: 'Progress', tooltip: 'Tooltip', spinner: 'Spinner', sidebar: 'Sidebar', breadcrumb: 'Breadcrumb', 'data-table': 'Data Table', table: 'Table', tabs: 'Tabs', 'dropdown-menu': 'DropdownMenu', drawer: 'Drawer', 'alert-dialog': 'AlertDialog', dialog: 'Dialog', empty: 'Empty', 'radio-group': 'RadioGroup', separator: 'Separator', avatar: 'Avatar', collapsible: 'Collapsible', popover: 'Popover', command: 'Command', sonner: 'Sonner', sheet: 'Sheet', label: 'Label' };
const L = n => `<a href="${DOC}${n}" target="_blank" rel="noopener">${NAMES[n] || n}</a>`;
const BLOCK = n => `<a href="https://ui.shadcn.com/view/new-york-v4/${n}" target="_blank" rel="noopener">${n}</a>`;
const SHELL_ACCOUNT = `Shell: ${BLOCK('dashboard-01')} (${L('sidebar')} variant="inset", collapsible="offcanvas"; SiteHeader with SidebarTrigger, ${L('breadcrumb')} and a View site button; NavUser ${L('dropdown-menu')}; ${L('sheet')} on mobile)`;
const SHELL_ADMIN = `Shell: ${BLOCK('sidebar-07')} (${L('sidebar')} collapsible="icon", logo header, NavUser with an area switch; header with SidebarTrigger and ${L('breadcrumb')}; ${L('sheet')} on mobile)`;
const S_ = (url, html) => ({ url, html });

const SCREENS = [
  { n: 1, group: 'Submitter', title: 'Sign in', route: '/login', states: [
    { id: 'email', label: 'Email entry', ...S_('/login/?callbackUrl=/submit/', () => page(loginEmail({ value: 'maya@quillmate.app' }))) },
    { id: 'code', label: 'Code entry', ...S_('/login/?callbackUrl=/submit/', () => page(loginCode())) },
    { id: 'wrong', label: 'Wrong code', ...S_('/login/?callbackUrl=/submit/', () => page(loginCode({ err: 'wrong' }))) },
    { id: 'expired', label: 'Expired code', ...S_('/login/?callbackUrl=/submit/', () => page(loginCode({ err: 'expired' }))) },
    { id: 'attempts', label: 'Too many wrong codes', ...S_('/login/?callbackUrl=/submit/', () => page(loginCode({ err: 'attempts' }))) },
    { id: 'limited', label: 'Rate-limited', ...S_('/login/?callbackUrl=/submit/', () => page(loginEmail({ value: 'maya@quillmate.app', limited: true }))) },
    { id: 'signedin', label: 'Signed in', ...S_('/login/?callbackUrl=/submit/', () => page(loginDone(), { auth: 'in' })) }
  ], notes: {
    d: ['Better Auth email OTP: a 6-digit code. One form signs people up and in.', 'Public site header and footer stay on this screen.', 'The code email is from SERP Directory &lt;noreply@mail.serp.co&gt; (see 15).'],
    a: ['Limits from #60’s suggestions: codes last 10 minutes, 5 wrong tries per code, 60 s resend cooldown, about 5 codes an hour.', 'After sign-in you return to the page that sent you (here, Submit, with the draft restored).'],
    m: [`Page and card: ${BLOCK('login-01')} (${L('card')} + ${L('field')} FieldGroup)`, `Email: ${L('input')} in a Field; errors: FieldError`, `Code: ${L('input-otp')} (3 + separator + 3; slots enlarged via className)`, `Notices: ${L('alert')}; actions: ${L('button')}; redirect: ${L('spinner')}`],
    c: ['Site header and footer (existing best.serp.co chrome).']
  } },
  { n: 2, group: 'Submitter', title: 'Submit', route: '/submit', states: [
    { id: 'signedout', label: 'Signed-out fill', ...S_('/submit/', () => page(submitPage({ signedOut: true, f: { ...prefilled, cat: 'AI Copywriting', catDesc: '' }, banner: Alert('default', 'Sign in when you’re ready', 'Fill in the form now. When you continue, we’ll email you a 6-digit code to sign in. Your draft stays in this browser.') }))) },
    { id: 'loading', label: 'Prefill loading', ...S_('/submit/', () => page(submitPage({ loading: true, addon: `${icon('loader', 'size-4 animate-spin')}<span class="text-xs">Reading page…</span>`, urlDesc: '', f: {} }), { auth: 'in' })) },
    { id: 'prefilled', label: 'Prefilled, editable', ...S_('/submit/', () => page(submitPage({ addon: `${icon('check', 'size-4 text-emerald-600')}<span class="text-xs">Details found</span>`, urlDesc: '', prefillNote: Alert('info', 'We filled in 3 fields from quillmate.app', 'Name, short description, and logo. Check each one and change anything. Pick a category yourself.', { actions: Button('Clear filled fields', { size: 'sm', v: 'ghost' }) }), f: prefilled }), { auth: 'in' })) },
    { id: 'failed', label: 'Prefill failed', ...S_('/submit/', () => page(submitPage({ addon: `${icon('warn', 'size-4 text-amber-600')}<span class="text-xs">Couldn’t read page</span>`, urlDesc: '', prefillNote: Alert('warning', 'We couldn’t read quillmate.app', 'The site didn’t respond within 8 seconds, so nothing was filled in. Enter the details yourself, or try again.', { actions: Button('Try again', { size: 'sm', v: 'outline', icon: 'refresh' }) }), f: { logo: 'empty' } }), { auth: 'in' })) },
    { id: 'errors', label: 'Field errors', ...S_('/submit/', () => page(submitPage({ summary: Alert('destructive', 'Fix 4 fields to continue', '<ul class="list-disc pl-5"><li>Name</li><li>Primary category</li><li>Short description</li><li>Logo</li></ul>'), f: { name: '', nameErr: 'Enter the product name.', cat: '', catErr: 'Choose a primary category.', short: PAGE_LONG, shortErr: `Keep it to 160 characters or fewer. It’s ${PAGE_LONG.length} now.`, logo: 'empty', logoErr: 'Add a logo. Upload an image or use the one from your site.' } }), { auth: 'in' })) },
    { id: 'duplisted', label: 'Duplicate: already listed', ...S_('/submit/', () => page(submitPage({ url: 'https://www.brieflow.ai/pricing', urlDesc: '', dup: dupListed(), f: { logo: 'empty' } }), { auth: 'in' })) },
    { id: 'duppending', label: 'Duplicate: pending (someone else)', ...S_('/submit/', () => page(submitPage({ url: 'https://brieflow.ai', urlDesc: '', dup: dupPending(false), f: { logo: 'empty' } }), { auth: 'in' })) },
    { id: 'dupmine', label: 'Duplicate: pending (yours)', ...S_('/submit/', () => page(submitPage({ url: 'https://clipwise.video', urlDesc: '', dup: dupPending(true), f: { logo: 'empty' } }), { auth: 'in' })) }
  ], notes: {
    d: ['<b>Revision 2:</b> the free/paid choice is no longer on this form. It comes next, on its own screen (2b).', 'Sign-in is required to continue. The form can be filled in signed out and is kept in this browser.', 'Required: URL, name, short description (160 max), primary category, logo. Optional: long description. FAQs and links are added later from the account.', 'Prefill without AI: name, description, favicon and OG image, all editable. Category is never prefilled.', 'A duplicate normalized domain is blocked: already listed offers “Claim this listing”; already pending is refused.'],
    a: ['Continue saves the submission (status pending badge) and opens 2b.', 'Logo rules: square PNG, JPG, SVG or WebP, at least 128 px, up to 1 MB. Where logos are stored is still open in #63.', 'Prefill gives up after 8 seconds, like the badge verifier.', 'Fields don\u2019t use red asterisks any more (shadcn style): optional fields say \u201c(optional)\u201d instead.', '<b>Revision 3:</b> the pending-duplicate dispute offers \u201cMessage us\u201d (a new claim conversation) instead of an email address.'],
    m: [`Form: ${L('card')} with ${L('field')} (FieldGroup, FieldLabel, FieldDescription, FieldError)`, `URL with prefill status: ${L('input-group')} with an inline-end addon and ${L('spinner')}`, `Name: ${L('input')}; category: ${L('select')}; descriptions: ${L('textarea')}`, `Loading: ${L('skeleton')}; notices, duplicate and error summary: ${L('alert')}`, `Logo source: ${L('toggle-group')}; duplicate listing preview: ${L('item')}`],
    c: ['Logo preview tile: shadcn has no file-upload or image-picker component, so it’s a preview square plus a Button and ToggleGroup.', 'Product monograms stand in for real logos.']
  } },
  { n: '2b', isNew: true, group: 'Submitter', title: 'Choose free or paid', route: '/submit/<id>/choose', states: [
    { id: 'default', label: 'Choose (after submit)', ...S_('/submit/s_4f9k2c/choose/', () => page(choosePlan('default'), { auth: 'in' })) },
    { id: 'later', label: 'Decide later: saved', ...S_('/submit/s_4f9k2c/choose/', () => page(choosePlan('later'), { auth: 'in' })) },
    { id: 'resumed', label: 'Resumed from account', ...S_('/submit/s_4f9k2c/choose/', () => page(choosePlan('resumed'), { auth: 'in' })) }
  ], notes: {
    d: ['<b>New in Revision 2</b> (owner request): the pay-or-badge choice comes after the form, so nobody leaves before entering their details.', 'Free: install the badge with a dofollow link, then review (goes to 3). Paid: $49 one-off, badge optional, live right after checks and still reviewed (goes to 4).', 'Nothing is reviewed or published until one path completes.'],
    a: ['Route <code>/submit/&lt;id&gt;/choose/</code>. The submission is already saved, so leaving loses nothing.', '<b>Decided (owner, revision 3):</b> a saved submission with no plan chosen has its own status, \u201cDraft \u2013 choose a plan\u201d, with Continue back here. \u201cPending badge\u201d now means free was chosen and the badge still needs installing or verifying. Drafts never reach the admin queue.'],
    m: [`Progress: ${L('progress')}; saved/welcome-back notices: ${L('alert')}`, `Submission summary: ${L('item')} (media, title, description, Edit action)`, `Options: two ${L('card')}s (CardDescription, CardTitle price, CardAction ${L('badge')}, CardFooter ${L('button')}), styled like dashboard-01’s section cards`, `“Decide later”: ${L('button')} variant link`],
    c: ['None.']
  } },
  { n: 3, group: 'Submitter', title: 'Badge step', route: '/submit/<id>/badge', states: [
    { id: 'embed', label: 'Embed code', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep(), { auth: 'in' })) },
    { id: 'checking', label: 'Checking', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'checking' }), { auth: 'in' })) },
    { id: 'pass', label: 'Pass', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'pass' }), { auth: 'in' })) },
    { id: 'missing', label: 'Missing', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'missing', left: 9 }), { auth: 'in' })) },
    { id: 'nofollow', label: 'Nofollow', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'nofollow', left: 8 }), { auth: 'in' })) },
    { id: 'wrong', label: 'Wrong destination', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'wrong', left: 7 }), { auth: 'in' })) },
    { id: 'unreachable', label: 'Unreachable', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'unreach', left: 7 }), { auth: 'in' })) },
    { id: 'cooldown', label: 'Cooldown', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'cooldown', left: 6 }), { auth: 'in' })) },
    { id: 'limit', label: 'Attempt limit', ...S_('/submit/s_4f9k2c/badge/', () => page(badgeStep({ r: 'limit', left: 0 }), { auth: 'in' })) }
  ], notes: {
    d: ['Reached from 2b (free) or from the account. The badge must link to /products/&lt;slug&gt;/ and be dofollow.', 'Existing verifier rules: 10 checks, one every 30 seconds. Network problems don’t use a check.', 'A pass sends the submission to review. Nothing publishes on its own.'],
    a: ['<b>Revision 2:</b> route moved from /account/submissions/&lt;id&gt;/badge/ to <code>/submit/&lt;id&gt;/badge/</code> so the funnel keeps the public header; steps are now 4 (Details, How to list, Badge, Review).', 'At the attempt limit we offer \u201cMessage us\u201d (revision 3, replaces support@serp.co) and the $49 path.'],
    m: [`Progress: ${L('progress')}; badge snippets: ${L('card')} with CardAction copy ${L('button')} + ${L('tooltip')} (“Copied”)`, `Snippet text: ${L('textarea')} (read-only, mono)`, `Verify panel: ${L('card')} with CardAction ${L('button')} (loading = ${L('spinner')})`, `Results (pass, missing, nofollow, wrong, unreachable, cooldown, limit): ${L('alert')}; pass tips: ${L('item')}`],
    c: ['The “Featured on SERP” badge artwork (existing site asset).']
  } },
  { n: 4, group: 'Submitter', title: 'Paid checkout', route: 'Stripe Checkout + /submit/<id>/checkout', states: [
    { id: 'handoff', label: 'Handoff to Stripe', ...S_('/submit/s_4f9k2c/checkout/', () => page(checkoutHandoff(), { auth: 'in' })) },
    { id: 'stripe', label: 'Stripe page (context)', ...S_('checkout.stripe.com/c/pay/cs_test_…', () => stripeWire()) },
    { id: 'confirming', label: 'Return: confirming', ...S_('/submit/s_4f9k2c/checkout/return/?session_id=cs_test_…', () => page(checkoutResult('confirming'), { auth: 'in' })) },
    { id: 'success', label: 'Success: live and in review', ...S_('/submit/s_4f9k2c/checkout/return/?session_id=cs_test_…', () => page(checkoutResult('live'), { auth: 'in' })) },
    { id: 'checksfail', label: 'Success: checks failed', extra: true, ...S_('/submit/s_4f9k2c/checkout/return/?session_id=cs_test_…', () => page(checkoutResult('checksfail'), { auth: 'in' })) },
    { id: 'cancelled', label: 'Cancelled', ...S_('/submit/s_4f9k2c/checkout/cancelled/', () => page(checkoutResult('cancelled'), { auth: 'in' })) },
    { id: 'failed', label: 'Failed', ...S_('/submit/s_4f9k2c/checkout/return/?session_id=cs_test_…', () => page(checkoutResult('failed'), { auth: 'in' })) }
  ], notes: {
    d: ['Reached from 2b (paid). $49 USD, one-off, through Stripe Checkout.', 'After payment, guardrail checks run. Pass: live right away and in the review queue. Fail: waits for review (dashed state).', 'A later rejection refunds in full automatically, unless it’s tagged prohibited.'],
    a: ['<b>Revision 2:</b> “Back to options” (returns to 2b) replaces “Install the badge instead” on handoff, cancelled and failed.', '“Confirming” covers the return page loading before Stripe’s webhook.', 'Stripe’s page is an unbranded wireframe for context only.'],
    m: [`Pages: ${L('card')}; order summary: ${L('item')}; order details: description list in CardContent`, `Status: ${L('badge')} (outline + icon); outcomes: ${L('alert')} (success, warning, destructive)`, `Loading: ${L('spinner')}; actions: ${L('button')}`],
    c: ['Stripe Checkout wireframe (Stripe-hosted, not ours).']
  } },
  { n: 5, rev4: true, group: 'Submitter', title: 'Account dashboard', route: '/account', shell: 'account', states: [
    { id: 'list', label: 'Overview: all statuses', rev4: true, ...S_('/account/', () => overview()) },
    { id: 'badgefail', label: 'Badge panel: failing', ...S_('/account/', () => overview({ badge: 'fail' })) },
    { id: 'badgepass', label: 'Badge panel: passing', ...S_('/account/', () => overview({ badge: 'pass' })) },
    { id: 'upgrade', label: 'Upgrade CTA', ...S_('/account/', () => overview({ upgrade: true })) },
    { id: 'menus', label: 'Navigation menus open', ...S_('/account/', () => overview({ menu: true })) },
    { id: 'empty', label: 'Empty', ...S_('/account/', () => overview({ empty: true })) }
  ], notes: {
    d: ['All eight status chips from #70: pending badge, in review, changes requested, live, live (paid, in review), rejected, withdrawn, unlisted.', 'Badge panel: last check, result, reason, re-verify (same 10-check limit and 30 s cooldown), embed code, history.', '“Upgrade: $49 one-off” on free listings. An unlisted listing comes back only by paying.'],
    a: ['<span class="q">Revision 4: new, needs approval.</span> The draft row shows \u201cExpires in 30 days\u201d (saved today) under its status (drafts expire after 30 days); the legend says so too.', 'Nav: Overview / Submissions / Listings / Settings. Overview lists everything; Submissions and Listings are filtered views of the same table. Settings (email, sign out) isn’t mocked yet.', '<b>Revision 3:</b> Tablesmith shows the new \u201cDraft \u2013 choose a plan\u201d status (Continue goes to 2b); Clipwise chose free and is \u201cPending badge\u201d (Add badge goes to 3). A \u201cWhat the statuses mean\u201d legend sits under the table, and the nav has Messages with an unread count.', 'The badge panel opens as a right-side Drawer (bottom sheet on mobile), like dashboard-01’s row viewer.'],
    m: [SHELL_ACCOUNT, `Counters: dashboard-01 SectionCards (${L('card')} + CardAction ${L('badge')})`, `List: ${L('data-table')} pattern on ${L('table')} with ${L('tabs')} (Select on mobile), row ${L('dropdown-menu')} trigger and the dashboard-01 pagination footer`, `Status: ${L('badge')} variant outline + colored lucide icon (dashboard-01 status column)`, `Badge panel: ${L('drawer')} with ${L('collapsible')} code, ${L('alert')}, ${L('table')}; empty: ${L('empty')}`],
    c: ['None beyond product monograms.']
  } },
  { n: 6, group: 'Submitter', title: 'Submission detail', route: '/account/submissions/<id>', shell: 'account', states: [
    { id: 'changes', label: 'Changes requested', ...S_('/account/submissions/s_9pd31x/', () => subDetail('changes')) },
    { id: 'review', label: 'In review', ...S_('/account/submissions/s_4f9k2c/', () => subDetail('review')) },
    { id: 'withdraw', label: 'Withdraw: confirm', ...S_('/account/submissions/s_4f9k2c/', () => subDetail('withdraw')) },
    { id: 'withdrawn', label: 'Withdrawn', ...S_('/account/submissions/s_4f9k2c/', () => subDetail('withdrawn')) },
    { id: 'rejected', label: 'Rejected (free)', ...S_('/account/submissions/s_2kd81p/', () => subDetail('rejected')) },
    { id: 'refunded', label: 'Rejected (paid, refunded)', ...S_('/account/submissions/s_7tq20z/', () => subDetail('refunded')) },
    { id: 'prohibited', label: 'Rejected (prohibited)', ...S_('/account/submissions/s_5hh3m0/', () => subDetail('prohibited')) }
  ], notes: {
    d: ['Changes requested: the reviewer’s note, edit, resubmit.', 'Withdraw while the submission is waiting.', 'Rejected shows the reason. Paid shows the refund, or no refund when tagged prohibited.'],
    a: ['<b>Revision 3:</b> every state has \u201cMessage the reviewers\u201d, which opens the conversation about this submission (screen 16). Change requests and rejections are posted there too. The prohibited state offers \u201cMessage us\u201d instead of support@serp.co.', 'The URL is locked on resubmit. Changing it means withdrawing and submitting again.', '<b>Decided (owner):</b> a prohibited rejection can\u2019t be resubmitted on either path until an admin lifts the block (see 12). The page says so and offers \u201cMessage us\u201d.'],
    m: [SHELL_ACCOUNT, `Reviewer note, rejection reason, notices: ${L('alert')}`, `Edit form and summaries: ${L('card')} + ${L('field')}; status: ${L('badge')}`, `Withdraw confirmation: ${L('alert-dialog')}`],
    c: ['History timeline: shadcn has no timeline component, so it’s a simple list inside a Card.']
  } },
  { n: 7, group: 'Submitter', title: 'Live listing edit', route: '/account/listings/<slug>/edit', shell: 'account', states: [
    { id: 'edit', label: 'Edit form', ...S_('/account/listings/ledgerly.app/edit/', () => liveEdit('edit')) },
    { id: 'adding', label: 'Adding FAQs and links', ...S_('/account/listings/ledgerly.app/edit/', () => liveEdit('adding')) },
    { id: 'pending', label: 'Revision pending review', ...S_('/account/listings/ledgerly.app/edit/', () => liveEdit('pending')) }
  ], notes: {
    d: ['Edits to a live listing create a revision that goes through review. The live version stays as it is until approved.', 'FAQs and links are added here.'],
    a: ['<b>Revision 3:</b> \u201cMessage the reviewers\u201d in the header opens the conversation about this listing (screen 16).', 'Editable: short and long description, logo, category, FAQs, links (#65). Name and URL changes are requested by message.', 'One pending revision at a time. It can be changed or discarded.'],
    m: [SHELL_ACCOUNT, `Form: ${L('card')} + ${L('field')} (FieldSet and FieldLegend for FAQs and Links)`, `FAQ rows: ${L('item')} holding ${L('input')} + ${L('textarea')}, remove = ghost icon ${L('button')}`, `Pending notice: ${L('alert')} with actions; new rows: ${L('badge')}`],
    c: ['Before/after diff colouring: shadcn has no diff component.']
  } },
  { n: 8, group: 'Submitter', title: 'Claim flow', route: '/products/<slug> (dialog)', states: [
    { id: 'method', label: 'Choose badge or paid', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(0) })) },
    { id: 'email', label: 'Domain email', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(1) })) },
    { id: 'code', label: 'Code', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(2) })) },
    { id: 'badge', label: 'Finish: badge', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(3) })) },
    { id: 'pay', label: 'Finish: payment', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(3, { paid: true }) })) },
    { id: 'done', label: 'Success', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { verified: true }), { auth: 'in', clip: true, overlay: claimDialog('done') })) },
    { id: 'webmail', label: 'Error: webmail', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(1, { err: 'webmail' }) })) },
    { id: 'mismatch', label: 'Error: domain mismatch', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(1, { err: 'domain' }) })) },
    { id: 'owned', label: 'Error: already owned', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog('owned') })) },
    { id: 'expired', label: 'Error: code expired', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(2, { err: 'expired' }) })) },
    { id: 'attempts', label: 'Error: too many attempts', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }), { auth: 'in', clip: true, overlay: claimDialog(2, { err: 'attempts' }) })) }
  ], notes: {
    d: ['Claim with the badge (free) or $49 paid, plus a code sent to an email on the product’s domain.', 'Webmail is refused, subdomains are allowed, and an already-owned listing is refused with a support contact.', 'Single-use code with 5 attempts and a cooldown. Ownership transfers instantly.'],
    a: ['<b>Revision 3:</b> \u201cAlready owned\u201d offers \u201cMessage us\u201d, which opens a new claim conversation (screen 16, \u201cNew message\u201d state) instead of showing support@serp.co.', 'Order: method, work email, code, then badge check or payment. Payment comes last so nobody pays before proving the email.', 'Lockout after 5 wrong codes lasts 15 minutes. Brieflow and jordan@brieflow.ai are fictional.'],
    m: [`Container: ${L('dialog')} on desktop, ${L('drawer')} on mobile (shadcn’s responsive dialog pattern)`, `Step indicator: ${L('progress')}; method: ${L('radio-group')} choice cards (${L('field')})`, `Email: ${L('field')} + ${L('input')} with FieldError; code: ${L('input-otp')}`, `Payment summary: ${L('item')}; already owned: \u201cMessage us\u201d ${L('button')}; notices: ${L('alert')}`],
    c: ['Listing page behind the dialog is the existing site page.']
  } },
  { n: 9, group: 'Submitter', title: 'Listing page changes', route: '/products/<slug>', states: [
    { id: 'unclaimed', label: 'Visitor: unclaimed', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { claim: true }))) },
    { id: 'owned', label: 'Visitor: verified owner', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { verified: true, tip: true }))) },
    { id: 'owner', label: 'Owner view', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { verified: true, ownerAlert: ownerAlert('owner') }), { auth: 'in' })) },
    { id: 'revision', label: 'Owner: edits in review', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { verified: true, ownerAlert: ownerAlert('revision') }), { auth: 'in' })) },
    { id: 'warn', label: 'Owner: badge warning', ...S_('/products/brieflow.ai/', () => page(listingPage(P.brief, { verified: true, ownerAlert: ownerAlert('warn') }), { auth: 'in' })) },
    { id: 'gone', label: 'Unpublished (410)', ...S_('/products/scrapebird.dev/  ·  HTTP 410 Gone', () => page(gonePage())) }
  ], notes: {
    d: ['\u201cClaim this listing\u201d appears on listing pages that have no owner.', '<b>Decided (owner):</b> owned listings show a small public \u201cVerified owner\u201d badge next to the name, with the tooltip \u201cThe maker verified ownership of this listing\u201d. Listing page only for now, not on category cards.', '<b>Decided (owner):</b> an unpublished listing\u2019s URL returns 410 Gone with a helpful page: it says the listing is gone, links to its category, and offers \u201cRelist it\u201d (sign-in, then relist or submit). Unpublished listings are removed from the sitemap, search and RSS.'],
    a: ['The claim link sits in the sidebar card under Category. Signed-out visitors go through /login first, then the dialog opens.', 'Owners see a notice above the hero (only to them) with badge status, edit link, pending edits, and badge warnings.', 'After “Relist it” and sign-in, the options depend on why it was removed: a listing unlisted for a missing badge comes back only as a paid listing (#59).'],
    m: [`Verified owner: ${L('badge')} variant secondary + ${L('tooltip')}`, `Claim link: ${L('button')} variant link; owner notices: ${L('alert')} with ${L('button')} actions; divider: ${L('separator')}`, `410 page: ${L('empty')} (title, description, category link) + ${L('item')} with the Relist ${L('button')}`],
    c: ['The listing page itself is today’s existing site page, unchanged for visitors.']
  } },
  { n: 16, isNew: 3, group: 'Submitter', title: 'Messages', route: '/account/messages', shell: 'account', states: [
    { id: 'list', label: 'Thread list (unread)', ...S_('/account/messages/', () => messagesPage('list')) },
    { id: 'thread', label: 'Thread with composer', ...S_('/account/messages/t_2q9d/', () => messagesPage('thread')) },
    { id: 'changes', label: 'Change request inline', ...S_('/account/messages/t_8k2p/', () => messagesPage('changes')) },
    { id: 'sending', label: 'Sending', ...S_('/account/messages/t_2q9d/', () => messagesPage('sending')) },
    { id: 'rate', label: 'Error: rate-limited', ...S_('/account/messages/t_2q9d/', () => messagesPage('rate')) },
    { id: 'long', label: 'Error: too long', ...S_('/account/messages/t_2q9d/', () => messagesPage('long')) },
    { id: 'new', label: 'New message (from \u201cMessage us\u201d)', ...S_('/account/messages/new/?about=claim:brieflow.ai', () => messagesPage('new')) },
    { id: 'mobile', label: 'Mobile: list, then thread', ...S_('/account/messages/', () => messagesPage('mobile')) },
    { id: 'empty', label: 'Empty', ...S_('/account/messages/', () => messagesPage('empty')) }
  ], notes: {
    d: ['<b>New in revision 3</b> (#73): replies happen inside the site, because email can\u2019t receive replies. A conversation belongs to one user and is about a submission, a listing they own, a claim, or general support.', 'Plain text, a length cap, no attachments. Unread state per side and an unread count in the nav.', 'Entry points: \u201cMessage the reviewers\u201d on 6 and 7, \u201cMessage us\u201d on 2, 3, 6 (prohibited) and 8 (already owned), the Messages nav item, and \u201cMessage us\u201d in the sidebar footer.', 'Change requests and rejections appear in the conversation with the reviewer\u2019s note, so the user can answer there.'],
    a: ['Length cap 2,000 characters; rate limit about 10 messages per 10 minutes. Links show as text in v1.', 'Replies are signed \u201cSERP team\u201d to submitters, not with the admin\u2019s name.', 'Routes <code>/account/messages/</code> and <code>/account/messages/&lt;thread&gt;/</code>. On mobile the list and the thread are separate views with a back arrow.', '\u201cMessage us\u201d prefills the About field (claim or general) and the related listing.'],
    m: [SHELL_ACCOUNT, `Thread list: ${BLOCK('sidebar-09')} inbox pattern (title, Unreads ${L('switch')}, search ${L('input')}, list rows) with ${L('badge')} for type`, `Thread: ${L('message')} + ${L('bubble')} (default for you, muted for the SERP team); day divider: ${L('field')} FieldSeparator; inline change request and rejection: ${L('alert')}`, `Composer: ${L('input-group')} with a textarea and a block-end addon (counter + Send ${L('button')}), ${L('spinner')} while sending; errors: ${L('alert')} (rate limit) and FieldError (too long)`, `New message: ${L('dialog')} (${L('drawer')} on mobile) with ${L('select')} + ${L('textarea')}; empty: ${L('empty')}`],
    c: ['None beyond product monograms and the unread dot.']
  } },
  { n: 10, group: 'Admin', title: 'Review queue', route: '/admin/submissions', shell: 'admin', states: [
    { id: 'queue', label: 'Queue', ...S_('/admin/submissions/', () => queue()) },
    { id: 'filtered', label: 'Filter open: paid', ...S_('/admin/submissions/?plan=paid', () => queue({ filter: true })) },
    { id: 'icons', label: 'Sidebar collapsed to icons', ...S_('/admin/submissions/', () => queue({ icons: true })) },
    { id: 'menus', label: 'Navigation menus open', ...S_('/admin/submissions/', () => queue({ menu: true })) },
    { id: 'empty', label: 'Empty', ...S_('/admin/submissions/', () => queue({ empty: true })) }
  ], notes: {
    d: ['Columns: age, source, plan, badge result, paid, status. Filters.', 'Paid listings that went live after payment are in the queue too.', '/admin sits behind Cloudflare Access and the admin allowlist.'],
    a: ['Source is “Submission” (new) or “Revision” (edit to a live listing).', 'Filters: status tabs, name/domain filter, faceted Source, Plan and Badge; sort by age (oldest first by default).', 'Admins switch to their own account from the user menu.'],
    m: [SHELL_ADMIN, `Queue: ${L('data-table')} pattern (${L('table')}, sortable header, row ${L('dropdown-menu')}, pagination footer)`, `Filters: ${L('tabs')} + ${L('input')} + faceted filters (${L('button')} outline dashed, ${L('popover')} + ${L('command')}, ${L('badge')})`, `Status, plan, badge: ${L('badge')}; empty: ${L('empty')}`],
    c: ['None beyond product monograms.']
  } },
  { n: 11, group: 'Admin', title: 'Submission review', route: '/admin/submissions/<id>', shell: 'admin', states: [
    { id: 'detail', label: 'Detail (free)', ...S_('/admin/submissions/s_4f9k2c/', () => reviewDetail('detail')) },
    { id: 'paid', label: 'Detail (paid, live)', ...S_('/admin/submissions/s_8m2q1d/', () => reviewDetail('paid')) },
    { id: 'edit', label: 'Approve with inline edit', ...S_('/admin/submissions/s_4f9k2c/', () => reviewDetail('edit')) },
    { id: 'approve', label: 'Approve: confirm', ...S_('/admin/submissions/s_4f9k2c/', () => reviewDetail('approve')) },
    { id: 'changes', label: 'Request changes', ...S_('/admin/submissions/s_4f9k2c/', () => reviewDetail('changes')) },
    { id: 'reject', label: 'Reject (free)', ...S_('/admin/submissions/s_4f9k2c/', () => reviewDetail('reject')) },
    { id: 'rejectpaid', label: 'Reject (paid, other: refund)', ...S_('/admin/submissions/s_8m2q1d/', () => reviewDetail('rejectPaid')) },
    { id: 'rejectconfirm', label: 'Reject: final confirm', ...S_('/admin/submissions/s_8m2q1d/', () => reviewDetail('rejectConfirm')) },
    { id: 'rejectprohibited', label: 'Reject (paid, prohibited)', ...S_('/admin/submissions/s_8m2q1d/', () => reviewDetail('rejectPaidProhibited')) }
  ], notes: {
    d: ['Listing preview, approve (optionally editing first), request changes with a note, reject with a reason and a category: prohibited = no refund, other = refund.', 'Rejecting a live paid listing unpublishes it. Decisions write to production D1 and are logged. New submissions default to nofollow.'],
    a: ['<b>Revision 3:</b> a Conversation panel in the right column shows the latest message from the submitter with a reply box. The request-changes and reject dialogs say the note is also posted to that conversation.', 'Paid rejections take two steps: choose the category, then confirm.', 'The outbound link can be set before approving.', 'For a paid listing that’s already live, Approve reads “Approve (keep live)”.'],
    m: [SHELL_ADMIN, `Preview and side panels: ${L('card')}; link setting: ${L('toggle-group')}; submitter: ${L('avatar')}`, `Inline edit: ${L('field')} form; paid banner: ${L('alert')}`, `Request changes and reject: ${L('dialog')} with ${L('textarea')} and ${L('radio-group')} choice cards`, `Approve and final reject confirmations: ${L('alert-dialog')}`],
    c: ['The listing preview reuses the existing site listing layout.']
  } },
  { n: 12, group: 'Admin', title: 'Listings', route: '/admin/listings', shell: 'admin', states: [
    { id: 'search', label: 'Search (row menu open)', ...S_('/admin/listings/?q=brief', () => listings('search')) },
    { id: 'detail', label: 'Listing detail', ...S_('/admin/listings/brieflow.ai/', () => listings('detail')) },
    { id: 'transfer', label: 'Transfer owner', ...S_('/admin/listings/brieflow.ai/', () => listings('transfer')) },
    { id: 'unpublish', label: 'Unpublish: confirm', ...S_('/admin/listings/brieflow.ai/', () => listings('unpublish')) },
    { id: 'unpublished', label: 'Unpublished (republish)', ...S_('/admin/listings/brieflow.ai/', () => listings('unpublished')) },
    { id: 'blocked', label: 'Rejected as prohibited (blocked)', ...S_('/admin/listings/keybazaar.shop/', () => blockedListing('blocked')) },
    { id: 'liftblock', label: 'Allow resubmission: confirm', ...S_('/admin/listings/keybazaar.shop/', () => blockedListing('liftblock')) }
  ], notes: {
    d: ['Search, edit, unpublish or republish, link setting (follow / nofollow / sponsored), owner (view and transfer), badge-check history.', 'Link defaults: follow for admin-added listings, nofollow for submissions.'],
    a: ['<b>Revision 3:</b> a Conversations panel lists the threads about this listing (Priya\u2019s claim dispute, Jordan\u2019s badge thread).', 'Transfer needs the new owner to have a SERP account.', '<b>Decided (owner):</b> unpublished URLs return 410 Gone with a helpful page (see 9) and leave the sitemap, search and RSS.', '<b>Decided (owner):</b> a URL rejected as prohibited stays blocked for resubmission and claims until an admin uses \u201cAllow resubmission\u201d (with confirmation).'],
    m: [SHELL_ADMIN, `List: ${L('data-table')} with faceted filters and a row ${L('dropdown-menu')} (shown open)`, `Detail: ${L('card')} + ${L('field')}; link: ${L('toggle-group')}; owner: ${L('item')} + ${L('avatar')}; badge checks: ${L('table')}`, `Transfer: ${L('dialog')}; unpublish and allow resubmission: ${L('alert-dialog')}; unpublished and blocked notices: ${L('alert')}`],
    c: ['Activity timeline: shadcn has no timeline component.']
  } },
  { n: 13, group: 'Admin', title: 'Orders', route: '/admin/orders', shell: 'admin', states: [
    { id: 'list', label: 'List (row menu open)', ...S_('/admin/orders/', () => orders('list')) },
    { id: 'refund', label: 'Refund: confirm (no badge)', ...S_('/admin/orders/', () => orders('refund')) },
    { id: 'refundbadge', label: 'Refund: confirm (passing badge)', ...S_('/admin/orders/', () => orders('refundbadge')) },
    { id: 'refunded', label: 'Refunded', ...S_('/admin/orders/', () => orders('refunded')) }
  ], notes: {
    d: ['Statuses: pending, paid, refunded, failed.', 'A refund action with confirmation.'],
    a: ['<b>Decided (owner):</b> a refund from Orders unpublishes the paid listing, unless it has a passing badge; then it stays live as a free listing. Both confirms show the listing status before and after.', 'A reason is required for the activity log.'],
    m: [SHELL_ADMIN, `Status filter: ${L('tabs')} with counts; list: ${L('data-table')}; row actions: ${L('dropdown-menu')} (Refund is the destructive item)`, `Refund: ${L('alert-dialog')} with ${L('alert')} and ${L('field')}; done: ${L('sonner')} toast`],
    c: ['None.']
  } },
  { n: 14, group: 'Admin', title: 'Admins', route: '/admin/admins', shell: 'admin', states: [
    { id: 'list', label: 'List and add', ...S_('/admin/admins/', () => admins('list')) },
    { id: 'adderr', label: 'Add: already an admin', ...S_('/admin/admins/', () => admins('adderr')) },
    { id: 'remove', label: 'Remove: confirm', ...S_('/admin/admins/', () => admins('remove')) },
    { id: 'last', label: 'Last admin', ...S_('/admin/admins/', () => admins('last')) }
  ], notes: {
    d: ['The allowlist starts with devin@serp.co. The last admin can’t be removed.', 'Production /admin is also behind Cloudflare Access.'],
    a: ['Adding an email grants admin the next time that person signs in. No invite email.', 'Admins can remove themselves while another admin exists.'],
    m: [SHELL_ADMIN, `Add: ${L('card')} + ${L('field')} + ${L('button')}; list: ${L('table')} with ${L('avatar')} and ${L('badge')}`, `Remove: ${L('alert-dialog')}; last admin: disabled ${L('button')} with ${L('tooltip')} and an ${L('alert')}`],
    c: ['None.']
  } },
  { n: 17, isNew: 3, group: 'Admin', title: 'Admin inbox', route: '/admin/inbox', shell: 'admin', states: [
    { id: 'inbox', label: 'Inbox', ...S_('/admin/inbox/', () => adminInbox('inbox')) },
    { id: 'filtered', label: 'Filtered: unread claims', ...S_('/admin/inbox/?unread=1&type=claim', () => adminInbox('filtered')) },
    { id: 'thread', label: 'Thread with reply', ...S_('/admin/inbox/t_3hq7/', () => adminInbox('thread')) },
    { id: 'empty', label: 'Empty', ...S_('/admin/inbox/', () => adminInbox('empty')) }
  ], notes: {
    d: ['<b>New in revision 3</b> (#73): every conversation, filterable by unread and by type (submission, listing, claim, general), with a reply composer.', 'Thread panels also appear on 11 (submission review) and 12 (listing detail). Request changes and reject post their note into the conversation.', 'Admins see all conversations (allowlist + Cloudflare Access); users only ever see their own.'],
    a: ['The thread view shows what the conversation is about (with quick actions such as Transfer owner) and who it\u2019s from.', 'The admin reply composer signs as the SERP team. The user\u2019s notification email never includes the reply text.', 'Admins can mark a conversation unread again.'],
    m: [SHELL_ADMIN, `Inbox: ${L('data-table')} pattern with ${L('tabs')} (All, Unread), ${L('input')} filter and a faceted Type filter (${L('popover')} + ${L('command')})`, `Thread: ${L('card')} with ${L('message')} + ${L('bubble')}, a system ${L('alert')}, and the ${L('input-group')} composer; context: ${L('card')} + ${L('item')} + ${L('avatar')}`, `Empty: ${L('empty')}`],
    c: ['None beyond product monograms and the unread dot.']
  } },
  { n: 15, rev4: true, rev5: true, group: 'Email', title: 'Emails', route: 'noreply@mail.serp.co', states: [
    { id: 'signin', label: 'Sign-in code', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.signin)) },
    { id: 'received', label: 'Submission received', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.received)) },
    { id: 'changes', label: 'Changes requested', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.changes)) },
    { id: 'approved', label: 'Approved / live', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.approved)) },
    { id: 'approvedpaid', label: 'Live after payment', extra: true, ...S_('Mail · hello@voxbloom.fm', () => email(EMAILS.approvedPaid)) },
    { id: 'rejected', label: 'Rejected', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.rejected)) },
    { id: 'rejectedpaid', label: 'Rejected (paid, refunded)', extra: true, ...S_('Mail · team@kiddotutor.com', () => email(EMAILS.rejectedPaid)) },
    { id: 'badge', label: 'Badge missing (24h warning)', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.badgeMissing)) },
    { id: 'unlisted', label: 'Unlisted', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.unlisted)) },
    { id: 'claim', label: 'Claim domain-email code', ...S_('Mail · jordan@brieflow.ai', () => email(EMAILS.claimCode)) },
    { id: 'admin', label: 'Admin: ready for review', ...S_('Mail · devin@serp.co', () => email(EMAILS.admin)) },
    { id: 'newmessage', label: 'You have a new message', ...S_('Mail · maya@quillmate.app', () => email(EMAILS.newMessage)) },
    { id: 'adminmessage', label: 'Admin: new message', ...S_('Mail · devin@serp.co', () => email(EMAILS.adminMessage)) },
    { id: 'draft12h', label: 'Draft reminder (+12h)', rev4: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.draftReminder12h)) },
    { id: 'draft21d', label: 'Draft reminder (+21d, last)', rev4: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.draftReminder21d)) },
    { id: 'draftpaid', label: 'Draft reminder (paid, checkout not done)', rev4: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.draftReminderPaid)) },
    { id: 'draftexpired', label: 'Draft expired (day 30)', rev4: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.draftExpired)) },
    { id: 'rejectedprohibited', label: 'Rejected: prohibited content', rev5: true, ...S_('Mail · admin@keybazaar.shop', () => email(EMAILS.rejectedProhibited)) },
    { id: 'paymentreview', label: 'Payment received: in review', rev5: true, ...S_('Mail · team@kiddotutor.com', () => email(EMAILS.paymentReview)) },
    { id: 'badgenone', label: 'Badge missing: not on the page', rev5: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.badgeMissingNone)) },
    { id: 'badgewrong', label: 'Badge missing: wrong destination', rev5: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.badgeMissingWrong)) },
    { id: 'adminpaidwait', label: 'Admin: ready (paid, waiting)', rev5: true, ...S_('Mail · devin@serp.co', () => email(EMAILS.adminPaidWait)) },
    { id: 'adminpaidlive', label: 'Admin: ready (paid, live now)', rev5: true, ...S_('Mail · devin@serp.co', () => email(EMAILS.adminPaidLive)) },
    { id: 'draftpaidlast', label: 'Draft reminder (checkout, +21d last)', rev5: true, ...S_('Mail · maya@quillmate.app', () => email(EMAILS.draftPaidLast)) },
    { id: 'ownerremoved', label: 'Ownership removed', extra: true, ...S_('Mail · jordan@brieflow.ai', () => email(EMAILS.ownerRemoved)) }
  ], notes: {
    d: ['<span class="q">Revision 5: new, needs approval.</span> Two emails that had no mockup: \u201cRejected: prohibited content\u201d (the URL can\u2019t be resubmitted, \u201cMessage us\u201d is the only path, no refund wording) and \u201cPayment received: in review\u201d (paid, guardrail checks failed, not live yet). Plus the variants the templates PR (#75) had to improvise, using its wording: badge findings \u201cnot on the page\u201d and \u201cwrong destination\u201d, the admin alert for paid submissions (\u201cpaid, waiting for review\u201d and \u201cpaid, live now\u201d with their Plan rows), and the +21d last reminder for \u201cComplete checkout\u201d.', '<b>Until #73 ships</b>, email footers (and the \u201cMessage us\u201d button) link to <code>/account/</code> for users and <code>/admin/</code> for admins instead of the Messages and Inbox pages shown here.', '<span class="q">Revision 4: new, needs approval.</span> Drafts expire after 30 days (owner decision). \u201cFinish your submission\u201d reminders go out at +12h, +48h, +7d, +14d and +21d with one template; only the line \u201cYour draft for &lt;Product&gt; expires in N days\u201d changes, and the +21d one is labelled the last reminder. CTA \u201cChoose a plan\u201d goes to <code>/submit/&lt;id&gt;/choose/</code>. Drafts where paid was chosen but checkout wasn\u2019t completed get the same reminders, with the CTA \u201cComplete checkout\u201d (<code>/submit/&lt;id&gt;/checkout/</code>) and a line about the $49 one-off. At day 30, \u201cYour draft expired\u201d says the URL is released and offers \u201cStart again\u201d.', 'From \u201cSERP Directory\u201d &lt;noreply@mail.serp.co&gt;, with <b>no Reply-To</b>. <b>Revision 3:</b> every footer says \u201cThis address isn\u2019t monitored. Reply from your dashboard\u201d with a link (Messages for users, the Inbox for admins), replacing support@serp.co.', '<b>New in revision 3:</b> \u201cYou have a new message\u201d (no message body, links to the conversation) and the admin \u201cNew message from a submitter\u201d alert (links to <code>/admin/inbox/&lt;thread&gt;/</code>). Both are throttled so a burst of messages sends one email.', 'The admin alert goes to devin@serp.co and links to <code>/admin/submissions/&lt;id&gt;/</code>.', 'Every email has a plain-text part (open it under each message).'],
    a: ['<b>Decided (owner):</b> sign-in and claim codes go in the subject, e.g. \u201c481902 is your SERP sign-in code\u201d.', 'The admin message alert leaves out the message body too, matching the user email. Bursts within 10 minutes are grouped.', 'Dashed states are extras: the paid \u201clive\u201d variant, the paid “rejected and refunded” variant, and the ownership-removed email from #66.'],
    m: ['Exempt: shadcn components don’t apply to email HTML. The layout keeps the same type, colours and button shape.'],
    c: ['All email markup (email-safe HTML, not shadcn).']
  } }
];
