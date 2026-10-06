/* ============ core: icons (lucide), data, shadcn/ui components ============ */
const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  plusCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevsLR: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  chevsRR: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
  chevsUD: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  arrowL: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowR: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  userCircle: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  dotsV: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  minusCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  minus: '<path d="M5 12h14"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  verified: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  box: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  xlogo: '<path d="M4 4l16 16"/><path d="M20 4 4 20"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  arrowUpDown: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>'
};
const icon = (n, cls = 'size-4') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cx = (...a) => a.filter(Boolean).join(' ');

/* ---------- example data (fictional products; real D1 categories) ---------- */
const SITE = 'https://best.serp.co';
const P = {
  quill: { name: 'Quillmate', domain: 'quillmate.app', color: '#1f6f5c', letter: 'Q', cat: 'AI Copywriting',
    short: 'Turns rough product notes into on-brand landing pages, emails, and ads, using a style guide that keeps every draft sounding like your team.',
    long: '## What Quillmate does\nQuillmate reads your product notes, changelog, and past launches, then drafts landing pages, emails, and ad variations in your team’s voice.\n\n## Who it is for\nSmall marketing teams and founders who ship often and write their own copy.' },
  brief: { name: 'Brieflow', domain: 'brieflow.ai', color: '#c2551f', letter: 'B', cat: 'AI Meeting Assistants', short: 'Records, transcribes, and summarizes sales calls, then drafts the follow-up email and updates your CRM fields.' },
  page: { name: 'Pagecraft', domain: 'pagecraft.dev', color: '#3b4fd8', letter: 'P', cat: 'AI Website Builders', short: 'The #1 best AI website builder!!! Build stunning sites 10x faster than anyone else. Try it free today.' },
  ledger: { name: 'Ledgerly', domain: 'ledgerly.app', color: '#0f766e', letter: 'L', cat: 'AI Tax Preparation', short: 'Categorizes freelancer expenses from your bank feed and prepares quarterly estimated tax worksheets.' },
  vox: { name: 'Voxbloom', domain: 'voxbloom.fm', color: '#9d2a7a', letter: 'V', cat: 'AI Text to Speech', short: 'Natural voiceovers for podcasts and explainer videos in 40 languages, with per-word pronunciation control.' },
  clip: { name: 'Clipwise', domain: 'clipwise.video', color: '#b45309', letter: 'C', cat: 'AI Clip Generators', short: 'Finds the strongest moments in long videos and cuts them into captioned vertical clips.' },
  table: { name: 'Tablesmith', domain: 'tablesmith.io', color: '#4338ca', letter: 'T', cat: 'AI Data Analyst', short: 'Ask questions about a spreadsheet in plain English and get charts you can paste into a deck.' },
  prompt: { name: 'Promptdeck', domain: 'promptdeck.io', color: '#4b5563', letter: 'P', cat: 'AI Prompt Generators', short: 'A library of tested prompts for marketing teams.' },
  meal: { name: 'Mealmap', domain: 'mealmap.co', color: '#65a30d', letter: 'M', cat: 'AI Nutritionist', short: 'Weekly meal plans built around your groceries, budget, and macros.' },
  scrape: { name: 'Scrapebird', domain: 'scrapebird.dev', color: '#0369a1', letter: 'S', cat: 'No Code Web Scrapers', short: 'Point-and-click scraping that exports any listing page to a spreadsheet on a schedule.' },
  ship: { name: 'Shipnote', domain: 'shipnote.so', color: '#7c3aed', letter: 'S', cat: 'AI Product Management', short: 'Turns merged pull requests into customer-facing release notes and roadmap updates.' },
  tutor: { name: 'Kiddo Tutor', domain: 'kiddotutor.com', color: '#db2777', letter: 'K', cat: 'AI Tutor', short: 'Patient step-by-step math and reading help for kids aged 6 to 12.' },
  keyb: { name: 'KeyBazaar', domain: 'keybazaar.shop', color: '#334155', letter: 'K', cat: 'Other', short: 'Discount license keys for Windows, Office, and design software.' },
  debrief: { name: 'Debrief', domain: 'debrief.so', color: '#0e7490', letter: 'D', cat: 'AI Note Takers', short: 'Meeting notes that turn into tasks in Linear and Jira.' },
  briefly: { name: 'Briefly Notes', domain: 'brieflynotes.com', color: '#a16207', letter: 'B', cat: 'AI Note Takers', short: 'Voice memos to tidy notes.' },
  formsy: { name: 'Formsy', domain: 'formsy.app', color: '#be123c', letter: 'F', cat: 'Auto Form Fill', short: 'Fills repetitive web forms from saved profiles.' },
  tidy: { name: 'Tidy Inbox', domain: 'tidyinbox.app', color: '#15803d', letter: 'T', cat: 'AI Email Writing Assistants', short: 'Triage and reply drafts for Gmail.' }
};
const listingUrl = p => `${SITE}/products/${p.domain}/`;

/* ---------- shadcn/ui building blocks ----------
   Classes follow packages/design-system/components/shadcn and the new-york-v4 registry
   (ui.shadcn.com/r/styles/new-york-v4/<name>.json), on the site's tokens. */
const BTN = {
  base: "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-all [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  v: {
    default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
    destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90 dark:bg-destructive/60',
    outline: 'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30',
    secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    link: 'text-primary underline-offset-4 hover:underline'
  },
  s: { default: 'h-9 px-4 py-2 has-[>svg]:px-3', sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5', lg: 'h-10 px-6 has-[>svg]:px-4', icon: 'size-9', iconSm: 'size-8', link: 'h-auto p-0' }
};
function Button(label, o = {}) {
  const ic = o.icon ? icon(o.icon, o.loading ? 'size-4 animate-spin' : 'size-4') : (o.loading ? icon('loader', 'size-4 animate-spin') : '');
  const icr = o.iconR ? icon(o.iconR, 'size-4') : '';
  return `<button type="button" data-slot="button" class="${cx(BTN.base, BTN.v[o.v || 'default'], BTN.s[o.size || 'default'], o.full && 'w-full', (o.disabled || o.loading) && 'pointer-events-none opacity-50', o.cls)}"${o.sr ? ` aria-label="${o.sr}"` : ''}>${ic}${label}${icr}</button>`;
}

const BADGE = {
  base: 'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium [&>svg]:size-3 [&>svg]:shrink-0',
  v: { default: 'border-transparent bg-primary text-primary-foreground', secondary: 'border-transparent bg-secondary text-secondary-foreground', destructive: 'border-transparent bg-destructive text-white dark:bg-destructive/60', outline: 'text-foreground' }
};
function Badge(label, o = {}) { return `<span data-slot="badge" class="${cx(BADGE.base, BADGE.v[o.v || 'default'], o.cls)}">${o.icon || ''}${label}</span>`; }

/* Status badges: dashboard-01's pattern (Badge variant="outline" + a colored lucide icon). */
const FILLED = (n, color) => icon(n, `${color} text-background`);
const STATUS = {
  plan_draft: ['Draft \u2013 choose a plan', icon('pencil', 'text-muted-foreground')],
  pending_badge: ['Pending badge', icon('clock', 'text-amber-500')],
  in_review: ['In review', icon('loader', 'text-sky-500')],
  changes: ['Changes requested', icon('msg', 'text-orange-500')],
  live: ['Live', FILLED('ok', 'fill-emerald-500 dark:fill-emerald-400')],
  live_paid: ['Live (paid, in review)', FILLED('ok', 'fill-teal-500 dark:fill-teal-400')],
  paid_wait: ['Paid, waiting for review', icon('clock', 'text-amber-500')],
  rejected: ['Rejected', FILLED('bad', 'fill-red-500 dark:fill-red-400')],
  withdrawn: ['Withdrawn', icon('undo', 'text-muted-foreground')],
  unlisted: ['Unlisted', icon('eyeOff', 'text-muted-foreground')],
  blocked: ['Rejected: prohibited', icon('ban', 'text-red-500')],
  revision: ['Revision in review', icon('loader', 'text-sky-500')],
  draft: ['Not paid', icon('minusCircle', 'text-muted-foreground')],
  pass: ['Pass', FILLED('ok', 'fill-emerald-500 dark:fill-emerald-400')],
  fail: ['Fail', FILLED('bad', 'fill-red-500 dark:fill-red-400')],
  miss_warn: ['Missing, recheck pending', icon('warn', 'text-amber-500')],
  inconclusive: ['Inconclusive', icon('minusCircle', 'text-muted-foreground')],
  na: ['Not required', icon('minusCircle', 'text-muted-foreground')],
  o_paid: ['Paid', FILLED('ok', 'fill-emerald-500 dark:fill-emerald-400')],
  o_pending: ['Pending', icon('clock', 'text-amber-500')],
  o_refunded: ['Refunded', icon('undo', 'text-muted-foreground')],
  o_failed: ['Failed', FILLED('bad', 'fill-red-500 dark:fill-red-400')]
};
function Status(k, label) { const [l, ic] = STATUS[k]; return Badge(label || l, { v: 'outline', icon: ic, cls: 'px-1.5 text-muted-foreground' }); }
const Plan = paid => Badge(paid ? 'Paid' : 'Free', { v: paid ? 'default' : 'outline' });

/* Alert: default and destructive are stock; warning/success are className tones on the
   default variant (shadcn ships no such variants). */
function Alert(tone, title, desc = '', o = {}) {
  const t = {
    default: ['bg-card text-card-foreground', 'info', 'text-muted-foreground'],
    destructive: ['bg-card text-destructive', 'bad', 'text-destructive/90'],
    warning: ['border-amber-500/40 bg-card text-amber-700 dark:text-amber-400', 'warn', 'text-muted-foreground'],
    success: ['border-emerald-500/40 bg-card text-emerald-700 dark:text-emerald-400', 'ok', 'text-muted-foreground'],
    info: ['border-sky-500/40 bg-card text-sky-700 dark:text-sky-400', 'info', 'text-muted-foreground']
  }[tone];
  if (desc && !/^\s*</.test(desc)) desc = `<p>${desc}</p>`;
  return `<div data-slot="alert" role="alert" class="${cx('relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[1rem_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current', t[0], o.cls)}">${icon(o.icon || t[1])}<div data-slot="alert-title" class="col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight">${title}</div>${desc || o.actions ? `<div data-slot="alert-description" class="${cx('col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed [overflow-wrap:anywhere] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs', t[2])}">${desc}${o.actions ? `<div class="mt-2 flex flex-wrap gap-2">${o.actions}</div>` : ''}</div>` : ''}</div>`;
}

/* Card (stock new-york-v4 layout, incl. CardAction) */
function Card(o = {}) {
  const t = o.title ? `<div data-slot="card-title" class="${cx('font-semibold leading-none', o.titleCls)}">${o.title}</div>` : '';
  const d = o.desc ? `<div data-slot="card-description" class="text-sm text-muted-foreground">${o.desc}</div>` : '';
  const header = o.title || o.desc || o.action ? `<div data-slot="card-header" class="${cx('grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6', o.action && 'grid-cols-[1fr_auto]', o.headerCls)}">${o.descFirst ? d + t : t + d}${o.action ? `<div data-slot="card-action" class="col-start-2 row-span-2 row-start-1 self-start justify-self-end">${o.action}</div>` : ''}</div>` : '';
  return `<div data-slot="card" class="${cx('flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm', o.cls)}">${header}${o.content != null ? `<div data-slot="card-content" class="${cx('px-6', o.contentCls)}">${o.content}</div>` : ''}${o.footer ? `<div data-slot="card-footer" class="${cx('flex px-6', /items-/.test(o.footerCls || '') ? '' : 'items-center', o.footerCls)}">${o.footer}</div>` : ''}</div>`;
}

/* Field family (ui.shadcn.com/docs/components/field) */
const FieldGroup = (inner, cls) => `<div data-slot="field-group" class="${cx('flex w-full flex-col gap-7', cls)}">${inner}</div>`;
const FieldLabel = (t, o = {}) => `<label data-slot="field-label" class="${cx('flex w-fit items-center gap-2 text-sm font-medium leading-snug', o.invalid && 'text-destructive')}">${t}${o.opt ? ' <span class="font-normal text-muted-foreground">(optional)</span>' : ''}</label>`;
const FieldDescription = (t, cls) => `<p data-slot="field-description" class="${cx('text-sm font-normal leading-normal text-muted-foreground', cls)}">${t}</p>`;
const FieldError = t => `<div role="alert" data-slot="field-error" class="text-sm font-normal text-destructive">${t}</div>`;
function inputBox(o = {}) {
  const st = o.invalid ? 'border-destructive ring-[3px] ring-destructive/20 dark:ring-destructive/40' : o.focus ? 'border-ring ring-[3px] ring-ring/50' : 'border-input';
  const val = o.value ? `<span class="${cx('truncate', o.mono && 'font-mono text-[13px]')}">${esc(o.value)}</span>${o.focus ? '<span class="caret ml-px h-4 w-px bg-foreground"></span>' : ''}` : `<span class="truncate text-muted-foreground">${esc(o.ph || '')}</span>${o.focus ? '<span class="caret -order-1 mr-px h-4 w-px bg-foreground"></span>' : ''}`;
  if (o.addon) {
    return `<div data-slot="input-group" class="${cx('relative flex h-9 w-full min-w-0 items-center rounded-md border shadow-xs dark:bg-input/30', st, o.disabled && 'opacity-50')}"><div data-slot="input-group-control" class="flex min-w-0 flex-1 items-center px-3 text-sm">${val}</div><div data-slot="input-group-addon" data-align="inline-end" class="flex h-auto shrink-0 items-center gap-2 pr-3 text-sm text-muted-foreground [&>svg]:size-4">${o.addon}</div></div>`;
  }
  return `<div data-slot="input" class="${cx('flex h-9 w-full min-w-0 items-center rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs dark:bg-input/30', st, o.disabled && 'opacity-50')}">${val}</div>`;
}
function textareaBox(o = {}) {
  const st = o.invalid ? 'border-destructive ring-[3px] ring-destructive/20 dark:ring-destructive/40' : 'border-input';
  return `<div data-slot="textarea" class="${cx('flex w-full whitespace-pre-wrap rounded-md border bg-transparent px-3 py-2 text-sm leading-relaxed shadow-xs dark:bg-input/30', o.tall ? 'min-h-36' : 'min-h-16', o.mono && 'font-mono text-xs', st, o.disabled && 'opacity-50')}">${o.value ? esc(o.value) : `<span class="text-muted-foreground">${esc(o.ph || '')}</span>`}</div>`;
}
function selectBox(o = {}) {
  const st = o.invalid ? 'border-destructive ring-[3px] ring-destructive/20 dark:ring-destructive/40' : 'border-input';
  return `<div data-slot="select-trigger" class="${cx('flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs dark:bg-input/30', st, o.cls)}"><span class="${o.value ? '' : 'text-muted-foreground'}">${esc(o.value || o.ph || 'Select…')}</span>${icon('chevD', 'size-4 opacity-50')}</div>`;
}
const Skeleton = cls => `<div data-slot="skeleton" class="${cx('animate-pulse rounded-md bg-primary/10', cls)}"></div>`;

/* A whole Field: label, control, description or error */
function Field(o) {
  const ctrl = o.skeleton ? Skeleton(o.area ? (o.tall ? 'h-36 w-full' : 'h-16 w-full') : 'h-9 w-full')
    : o.area ? textareaBox(o) : o.select ? selectBox({ value: o.value, ph: o.ph || 'Choose a category', invalid: !!o.error }) : inputBox({ ...o, invalid: !!o.error });
  let count = '';
  if (o.max) { const n = (o.value || '').length; count = `<span class="${cx('ml-auto shrink-0 text-xs tabular-nums', n > o.max ? 'font-medium text-destructive' : 'text-muted-foreground')}">${n}/${o.max}</span>`; }
  return `<div data-slot="field" data-invalid="${!!o.error}" class="${cx('flex w-full flex-col gap-3', o.cls)}">
    <div class="flex items-center gap-2">${FieldLabel(o.label, { opt: o.opt, invalid: !!o.error })}${o.tag ? `<span class="ml-auto text-xs text-muted-foreground">${o.tag}</span>` : ''}</div>
    ${ctrl}
    ${o.error || o.desc || count ? `<div class="flex items-start gap-3">${o.error ? FieldError(o.error) : o.desc ? FieldDescription(o.desc) : ''}${count}</div>` : ''}
  </div>`;
}

/* RadioGroup choice card (Field "choice card" pattern) */
function ChoiceCard(title, desc, checked, o = {}) {
  return `<label data-slot="field-label" class="${cx('flex w-full flex-col rounded-md border', checked ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-border')}"><div data-slot="field" class="flex w-full items-start gap-3 p-4">
    <span data-slot="radio-group-item" class="${cx('mt-px grid aspect-square size-4 shrink-0 place-items-center rounded-full border shadow-xs dark:bg-input/30', checked ? 'border-primary' : 'border-input')}">${checked ? '<span class="size-2 rounded-full bg-primary"></span>' : ''}</span>
    <div data-slot="field-content" class="flex flex-1 flex-col gap-1.5 leading-snug"><div data-slot="field-title" class="flex w-fit items-center gap-2 text-sm font-medium leading-snug">${title}${o.badge || ''}</div><p class="text-sm font-normal leading-normal text-muted-foreground">${desc}</p></div>
  </div></label>`;
}

/* InputOTP: 3 + separator + 3 (input-otp docs pattern); slots enlarged via className */
function InputOTP(digits, o = {}) {
  const slot = i => {
    const ch = digits[i] || '';
    const active = o.active === i;
    return `<div data-slot="input-otp-slot" data-active="${active}" class="${cx('relative flex h-10 w-10 items-center justify-center border-y border-r text-base shadow-xs first:rounded-l-md first:border-l last:rounded-r-md dark:bg-input/30', o.invalid ? 'border-destructive' : 'border-input', active && 'z-10 border-ring ring-[3px] ring-ring/50')}">${ch}${active && !ch ? '<div class="pointer-events-none absolute inset-0 flex items-center justify-center"><div class="caret h-4 w-px bg-foreground"></div></div>' : ''}</div>`;
  };
  return `<div data-slot="input-otp" class="flex items-center gap-2"><div data-slot="input-otp-group" class="flex items-center">${[0, 1, 2].map(slot).join('')}</div><div data-slot="input-otp-separator" role="separator" class="text-muted-foreground">${icon('minus')}</div><div data-slot="input-otp-group" class="flex items-center">${[3, 4, 5].map(slot).join('')}</div></div>`;
}

const Separator = (vertical, cls) => `<div data-slot="separator" class="${cx('shrink-0 bg-border', vertical ? 'h-4 w-px' : 'h-px w-full', cls)}"></div>`;
function Progress(pct, cls) { return `<div data-slot="progress" class="${cx('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', cls)}"><div data-slot="progress-indicator" class="h-full bg-primary" style="width:${pct}%"></div></div>`; }
function StepProgress(n, total, label) { return `<div class="space-y-2"><div class="flex items-center justify-between text-sm"><span class="font-medium">${label}</span><span class="text-muted-foreground">Step ${n} of ${total}</span></div>${Progress(Math.round((n / total) * 100))}</div>`; }
function Avatar(initials, o = {}) { return `<span data-slot="avatar" class="${cx('relative flex size-8 shrink-0 overflow-hidden', o.lg ? 'rounded-lg' : 'rounded-full')}"><span data-slot="avatar-fallback" class="${cx('flex size-full items-center justify-center bg-muted text-sm text-muted-foreground', o.lg ? 'rounded-lg' : 'rounded-full')}">${initials}</span></span>`; }
function Breadcrumb(items) {
  return `<nav aria-label="breadcrumb" data-slot="breadcrumb"><ol data-slot="breadcrumb-list" class="flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground @sm:gap-2.5">${items.map((t, i) => {
    const last = i === items.length - 1;
    return `<li data-slot="breadcrumb-item" class="${cx('inline-flex items-center gap-1.5', !last && i < items.length - 2 && 'hidden @md:inline-flex')}">${last ? `<span data-slot="breadcrumb-page" aria-current="page" class="font-normal text-foreground">${t}</span>` : `<a data-slot="breadcrumb-link" class="transition-colors hover:text-foreground">${t}</a>`}</li>${last ? '' : `<li role="presentation" data-slot="breadcrumb-separator" class="${cx('[&>svg]:size-3.5', i < items.length - 2 && 'hidden @md:block')}">${icon('chevR')}</li>`}`;
  }).join('')}</ol></nav>`;
}
function Tabs(items, active, o = {}) {
  return `<div data-slot="tabs-list" class="${cx('inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground', o.cls)}">${items.map(([k, l, n]) => `<button data-slot="tabs-trigger" data-state="${k === active ? 'active' : 'inactive'}" class="${cx('inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 py-1 text-sm font-medium', k === active ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30' : 'text-foreground/60')}">${l}${n != null ? ` <span data-slot="badge" class="inline-flex size-5 items-center justify-center rounded-full bg-muted-foreground/30 px-1 text-xs font-medium text-foreground">${n}</span>` : ''}</button>`).join('')}</div>`;
}
function ToggleGroup(opts, sel) {
  return `<div data-slot="toggle-group" data-variant="outline" class="flex w-fit items-center rounded-md shadow-xs">${opts.map((x, i) => `<button data-slot="toggle-group-item" data-state="${x === sel ? 'on' : 'off'}" class="${cx('inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 border border-input bg-transparent px-3 text-sm font-medium', i === 0 ? 'rounded-l-md' : 'border-l-0', i === opts.length - 1 && 'rounded-r-md', x === sel ? 'bg-accent text-accent-foreground' : 'hover:bg-muted hover:text-muted-foreground')}">${x}</button>`).join('')}</div>`;
}
function Tooltip(text, child) { return `<span class="relative inline-flex">${child}<span data-slot="tooltip-content" class="absolute bottom-full left-1/2 z-50 mb-2 w-fit -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-3 py-1.5 text-xs text-background">${text}<span class="absolute left-1/2 top-full size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] bg-foreground"></span></span></span>`; }
function Empty(o) {
  return `<div data-slot="empty" class="${cx('flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance rounded-lg border border-dashed p-6 text-center @md:p-12', o.cls)}"><div data-slot="empty-header" class="flex max-w-sm flex-col items-center gap-2 text-center"><div data-slot="empty-icon" class="mb-2 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">${icon(o.icon, 'size-6')}</div><div data-slot="empty-title" class="text-lg font-medium tracking-tight">${o.title}</div><div data-slot="empty-description" class="text-sm/relaxed text-muted-foreground">${o.desc}</div></div>${o.actions ? `<div data-slot="empty-content" class="flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm"><div class="flex flex-wrap justify-center gap-2">${o.actions}</div></div>` : ''}</div>`;
}
/* Item (ui.shadcn.com/docs/components/item) */
function Item(o) {
  return `<div data-slot="item" class="${cx('flex flex-wrap items-center gap-4 rounded-md border p-4 text-sm', o.v === 'muted' ? 'border-transparent bg-muted/50' : 'border-border', o.cls)}">${o.media ? `<div data-slot="item-media" class="flex shrink-0 items-center justify-center self-start">${o.media}</div>` : ''}<div data-slot="item-content" class="flex min-w-0 flex-1 flex-col gap-1"><div data-slot="item-title" class="flex w-fit items-center gap-2 text-sm font-medium leading-snug">${o.title}</div>${o.desc ? `<p data-slot="item-description" class="line-clamp-2 text-balance text-sm font-normal leading-normal text-muted-foreground">${o.desc}</p>` : ''}</div>${o.actions ? `<div data-slot="item-actions" class="flex items-center gap-2">${o.actions}</div>` : ''}</div>`;
}
/* DropdownMenu content (static, open) */
function Menu(items, o = {}) {
  return `<div data-slot="dropdown-menu-content" class="${cx('z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md', o.cls)}">${items.map(it => {
    if (it === '-') return '<div data-slot="dropdown-menu-separator" class="-mx-1 my-1 h-px bg-border"></div>';
    if (it.label) return `<div data-slot="dropdown-menu-label" class="px-2 py-1.5 text-sm font-medium">${it.label}</div>`;
    if (it.raw) return it.raw;
    return `<div data-slot="dropdown-menu-item" class="${cx('relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm [&_svg]:size-4', it.danger ? 'text-destructive [&_svg]:!text-destructive' : '[&_svg]:text-muted-foreground', it.focus && 'bg-accent text-accent-foreground')}">${it.icon ? icon(it.icon) : ''}${it.t}${it.k ? `<span class="ml-auto text-xs tracking-widest text-muted-foreground">${it.k}</span>` : ''}</div>`;
  }).join('')}</div>`;
}
/* Sonner toast */
function Toast(title, o = {}) {
  return `<div class="absolute bottom-6 left-1/2 z-50 flex w-[356px] max-w-[calc(100%-2rem)] -translate-x-1/2 items-start gap-2 rounded-lg border bg-popover p-4 text-[13px] text-popover-foreground shadow-lg @sm:left-auto @sm:right-6 @sm:translate-x-0" data-sonner-toast>${icon(o.icon || 'ok', 'mt-px size-4 shrink-0')}<div><div class="font-medium">${title}</div>${o.desc ? `<div class="text-muted-foreground">${o.desc}</div>` : ''}</div></div>`;
}

/* Dialog / AlertDialog / responsive Drawer (absolute so they sit inside the mockup frame) */
function Dialog(o) {
  const head = o.alert
    ? `<div data-slot="alert-dialog-header" class="grid place-items-center gap-1.5 text-center @sm:place-items-start @sm:text-left"><h2 data-slot="alert-dialog-title" class="text-lg font-semibold">${o.title}</h2>${o.desc ? `<p data-slot="alert-dialog-description" class="text-sm text-muted-foreground">${o.desc}</p>` : ''}</div>`
    : `<div data-slot="dialog-header" class="flex flex-col gap-2 text-center @sm:text-left"><h2 data-slot="dialog-title" class="text-lg font-semibold leading-none">${o.title}</h2>${o.desc ? `<p data-slot="dialog-description" class="text-sm text-muted-foreground">${o.desc}</p>` : ''}</div>`;
  const content = `<div role="${o.alert ? 'alertdialog' : 'dialog'}" data-slot="${o.alert ? 'alert-dialog-content' : 'dialog-content'}" class="${cx('relative grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-lg border bg-background p-6 shadow-lg [&>*]:min-w-0', o.w || '@sm:max-w-lg')}">${head}${o.body || ''}${o.footer ? `<div data-slot="${o.alert ? 'alert-dialog-footer' : 'dialog-footer'}" class="flex flex-col-reverse gap-2 @sm:flex-row @sm:justify-end">${o.footer}</div>` : ''}${o.alert ? '' : `<button data-slot="dialog-close" class="absolute right-4 top-4 rounded-xs opacity-70 hover:opacity-100" aria-label="Close">${icon('x')}</button>`}</div>`;
  const dlg = `<div class="${cx('absolute inset-x-0 z-50 flex justify-center', o.top || 'top-24', o.drawer && 'hidden @sm:flex')}">${content}</div>`;
  const drawer = o.drawer ? `<div data-slot="drawer-content" class="absolute inset-x-0 bottom-0 z-50 flex max-h-[85%] flex-col rounded-t-lg border-t bg-background @sm:hidden"><div class="mx-auto mt-4 h-2 w-[100px] shrink-0 rounded-full bg-muted"></div><div data-slot="drawer-header" class="flex flex-col gap-0.5 p-4 text-center"><h2 data-slot="drawer-title" class="font-semibold text-foreground">${o.title}</h2>${o.desc ? `<p data-slot="drawer-description" class="text-sm text-muted-foreground">${o.desc}</p>` : ''}</div><div class="min-w-0 overflow-y-auto px-4">${o.body || ''}</div>${o.footer ? `<div data-slot="drawer-footer" class="mt-auto flex flex-col-reverse gap-2 p-4">${o.footer}</div>` : ''}</div>` : '';
  return `<div data-slot="${o.alert ? 'alert-dialog-overlay' : 'dialog-overlay'}" class="absolute inset-0 z-40 bg-black/80"></div>${dlg}${drawer}`;
}
/* Right-side Drawer (dashboard-01's TableCellViewer: right on desktop, bottom on mobile) */
function SideDrawer(o) {
  return `<div data-slot="drawer-overlay" class="absolute inset-0 z-40 bg-black/80"></div>
  <div data-slot="drawer-content" class="absolute inset-x-0 bottom-0 z-50 flex max-h-[85%] flex-col rounded-t-lg border-t bg-background @md:inset-x-auto @md:inset-y-0 @md:right-0 @md:max-h-none @md:w-[26rem] @md:rounded-none @md:border-l @md:border-t-0">
    <div class="mx-auto mt-4 h-2 w-[100px] shrink-0 rounded-full bg-muted @md:hidden"></div>
    <div data-slot="drawer-header" class="flex flex-col gap-1 p-4 text-center @md:text-left"><h2 class="font-semibold text-foreground">${o.title}</h2>${o.desc ? `<p class="text-sm text-muted-foreground">${o.desc}</p>` : ''}</div>
    <div class="flex flex-col gap-4 overflow-y-auto px-4 text-sm">${o.body}</div>
    <div data-slot="drawer-footer" class="mt-auto flex flex-col gap-2 p-4">${o.footer}</div>
  </div>`;
}

/* Data table (dashboard-01 / data-table docs): bordered Table with a muted header */
function DataTable(cols, rows, o = {}) {
  const thc = 'h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-foreground first:pl-4 last:pr-4';
  const tdc = 'whitespace-nowrap p-2 align-middle first:pl-4 last:pr-4';
  const body = rows.length
    ? rows.map(r => `<tr data-slot="table-row" class="${cx('border-b transition-colors last:border-0 hover:bg-muted/50', r.sel && 'bg-muted/50')}">${r.cells.map((c, i) => `<td data-slot="table-cell" class="${cx(tdc, o.right && o.right.includes(i) && 'text-right')}">${c}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" class="h-24 text-center text-muted-foreground">No results.</td></tr>`;
  return `<div class="${cx('overflow-hidden rounded-lg border', o.cls)}"><div data-slot="table-container" class="relative w-full overflow-x-auto"><table data-slot="table" class="w-full caption-bottom text-sm"><thead data-slot="table-header" class="bg-muted"><tr class="border-b">${cols.map((c, i) => `<th data-slot="table-head" class="${cx(thc, o.right && o.right.includes(i) && 'text-right')}">${c}</th>`).join('')}</tr></thead><tbody data-slot="table-body">${body}</tbody></table></div>${o.after || ''}</div>`;
}
function TableFooter(left, page, pages) {
  const ib = (n, dis, cls) => Button('', { v: 'outline', size: 'iconSm', icon: n, disabled: dis, cls });
  return `<div class="flex items-center justify-between gap-4 pt-4"><div class="hidden flex-1 text-sm text-muted-foreground @md:flex">${left}</div><div class="flex w-full items-center gap-6 @md:w-fit"><div class="hidden items-center gap-2 @lg:flex"><span class="whitespace-nowrap text-sm font-medium">Rows per page</span>${selectBox({ value: '10', cls: 'h-8 w-20' })}</div><div class="flex w-fit items-center justify-center text-sm font-medium">Page ${page} of ${pages}</div><div class="ml-auto flex items-center gap-2 @md:ml-0">${ib('chevsLR', page === 1, 'hidden @lg:flex')}${ib('chevL', page === 1)}${ib('chevR', page === pages)}${ib('chevsRR', page === pages, 'hidden @lg:flex')}</div></div></div>`;
}
const RowMenu = () => Button('', { v: 'ghost', size: 'iconSm', icon: 'dotsV', cls: 'text-muted-foreground', sr: 'Open menu' });

/* Faceted filter (data-table docs toolbar): dashed outline Button + Popover/Command */
function Facet(title, selected = []) {
  return `<button data-slot="button" class="${cx(BTN.base, BTN.v.outline, 'h-8 gap-1.5 border-dashed px-2.5')}">${icon('plusCircle')}${title}${selected.length ? `${Separator(true, 'mx-1')}${selected.map(s => `<span data-slot="badge" class="${cx(BADGE.base, BADGE.v.secondary, 'rounded-sm px-1 font-normal')}">${s}</span>`).join('')}` : ''}</button>`;
}
function CommandList(ph, items) {
  return `<div data-slot="popover-content" class="z-50 w-[200px] rounded-md border bg-popover p-0 text-popover-foreground shadow-md"><div data-slot="command" class="flex flex-col overflow-hidden rounded-md"><div data-slot="command-input-wrapper" class="flex h-9 items-center gap-2 border-b px-3">${icon('search', 'size-4 shrink-0 opacity-50')}<span class="text-sm text-muted-foreground">${ph}</span></div><div data-slot="command-list" class="p-1">${items.map(([l, n, on]) => `<div data-slot="command-item" class="relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm"><div class="${cx('flex size-4 items-center justify-center rounded-[4px] border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input [&_svg]:invisible')}">${icon('check', 'size-3.5')}</div><span>${l}</span><span class="ml-auto flex size-4 items-center justify-center font-mono text-xs text-muted-foreground">${n}</span></div>`).join('')}<div class="-mx-1 my-1 h-px bg-border"></div><div class="flex justify-center rounded-sm px-2 py-1.5 text-sm">Clear filters</div></div></div></div>`;
}

/* Message + Bubble (ui.shadcn.com/docs/components/message, /bubble) */
function Msg(o) {
  const end = o.align === 'end';
  const v = o.variant || (end ? 'default' : 'muted');
  const bc = { default: 'bg-primary text-primary-foreground', muted: 'bg-muted', outline: 'border-border bg-background' }[v];
  const content = o.body != null ? `<div data-slot="bubble" data-variant="${v}" data-align="${end ? 'end' : 'start'}" class="${cx('relative flex w-fit min-w-0 max-w-[85%] flex-col gap-1 @md:max-w-[80%]', end && 'self-end', o.pending && 'opacity-60')}"><div data-slot="bubble-content" class="${cx('w-fit min-w-0 max-w-full overflow-hidden whitespace-pre-line break-words rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed', bc, end && 'self-end')}">${o.body}</div></div>` : (o.block || '');
  return `<div data-slot="message" data-align="${end ? 'end' : 'start'}" class="${cx('group/message relative flex w-full min-w-0 gap-2 text-sm', end && 'flex-row-reverse')}">
    <div data-slot="message-avatar" class="${cx('flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted', o.footer && '-translate-y-6')}">${o.avatar || ''}</div>
    <div data-slot="message-content" class="flex w-full min-w-0 flex-col gap-2.5 break-words">
      ${o.header ? `<div data-slot="message-header" class="${cx('flex min-w-0 max-w-full items-center gap-2 px-3 text-xs font-medium text-muted-foreground', end && 'justify-end')}">${o.header}</div>` : ''}
      ${content}
      ${o.footer ? `<div data-slot="message-footer" class="${cx('flex min-w-0 max-w-full items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground', end && 'justify-end')}">${o.footer}</div>` : ''}
    </div>
  </div>`;
}
const teamAvatar = () => `<span data-slot="avatar" class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">${serpMark('size-4')}</span>`;
/* Composer: InputGroup with a textarea and a block-end addon (input-group-textarea example) */
function Composer(o = {}) {
  const st = o.invalid ? 'border-destructive ring-[3px] ring-destructive/20 dark:ring-destructive/40' : o.focus ? 'border-ring ring-[3px] ring-ring/50' : 'border-input';
  const n = (o.value || '').length;
  const count = o.count != null ? o.count : n;
  return `<div class="flex flex-col gap-2"><div data-slot="input-group" class="${cx('relative flex h-auto w-full min-w-0 flex-col rounded-md border shadow-xs dark:bg-input/30', st, o.disabled && 'opacity-60')}">
    <div data-slot="input-group-control" class="${cx('min-h-[72px] w-full whitespace-pre-line px-3 py-3 text-sm', !o.value && 'text-muted-foreground')}">${o.value ? esc(o.value) : esc(o.ph || 'Write a message…')}${o.focus && !o.disabled ? '<span class="caret ml-px inline-block h-4 w-px translate-y-0.5 bg-foreground"></span>' : ''}</div>
    <div data-slot="input-group-addon" data-align="block-end" class="flex w-full items-center justify-start gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
      <span class="${cx('text-xs tabular-nums', count > 2000 && 'font-medium text-destructive')}">${count.toLocaleString('en-US')}/2,000</span>
      <span class="hidden text-xs @sm:inline">${o.hint || 'Plain text. No attachments.'}</span>
      <span class="ml-auto">${o.sending ? Button('Sending…', { size: 'sm', loading: true }) : Button(o.send || 'Send', { size: 'sm', iconR: 'arrowR', disabled: o.disabled || o.invalid })}</span>
    </div>
  </div>${o.error ? FieldError(o.error) : o.desc ? FieldDescription(o.desc) : ''}</div>`;
}
/* Switch (stock) */
function Switch(on) { return `<span data-slot="switch" data-state="${on ? 'checked' : 'unchecked'}" class="${cx('inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs', on ? 'bg-primary' : 'bg-input dark:bg-input/80')}"><span data-slot="switch-thumb" class="${cx('pointer-events-none block size-4 rounded-full bg-background ring-0', on ? 'translate-x-[calc(100%-2px)] dark:bg-primary-foreground' : 'translate-x-0 dark:bg-foreground')}"></span></span>`; }

/* Custom pieces that have no shadcn equivalent */
function logo(p, size = 40, o = {}) {
  const r = o.r || (size >= 56 ? 'rounded-xl' : size >= 32 ? 'rounded-lg' : 'rounded-md');
  return `<span class="${cx('inline-grid shrink-0 place-items-center font-bold text-white', r, o.cls)}" style="width:${size}px;height:${size}px;background:${p.color};font-size:${Math.round(size * 0.46)}px;line-height:1">${p.letter}</span>`;
}
const SERP_MARK = 'M 127.62 540.68 C 255.64 429.97 383.70 319.31 511.76 208.65 C 639.74 319.23 767.70 429.86 895.69 540.45 C 895.70 631.71 895.73 722.97 895.64 814.23 C 719.72 662.17 543.76 510.14 367.81 358.10 C 398.86 414.80 429.83 471.54 460.92 528.22 C 349.85 623.79 238.69 719.27 127.67 814.91 C 127.66 723.50 127.67 632.09 127.62 540.68 Z';
const serpMark = cls => `<svg viewBox="0 0 1024 1024" class="${cls}" aria-hidden="true"><path fill="currentColor" d="${SERP_MARK}"/></svg>`;
function badgeSvg(theme = 'light', w = 200) {
  const d = theme === 'dark';
  return `<svg width="${w}" height="${w / 4}" viewBox="0 0 200 50" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Featured on SERP"><rect x="1" y="1" width="198" height="48" rx="5" fill="${d ? '#1a1a1a' : '#ffffff'}" stroke="${d ? '#333333' : '#e5e7eb'}"/><g transform="translate(12 15) scale(0.01953)"><path fill="${d ? '#ffffff' : '#000000'}" d="${SERP_MARK}"/></g><text x="42" y="20" font-family="system-ui,-apple-system,sans-serif" font-size="8" font-weight="500" fill="${d ? '#ffffff' : '#000000'}" opacity="0.8">FEATURED ON</text><text x="42" y="36" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="700" fill="${d ? '#eeeeee' : '#000000'}">SERP</text></svg>`;
}
const embedCode = (p, theme = 'light') => `<a href="${listingUrl(p)}" target="_blank" rel="noopener noreferrer" title="Featured on SERP">\n  <img src="${SITE}/badge/featured-on-serp.co-${theme}.svg" alt="Featured on SERP" width="200" height="50" />\n</a>`;
function kv(rows) {
  return `<dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm @sm:grid-cols-[max-content_1fr]">${rows.map(([k, v]) => `<dt class="text-muted-foreground">${k}</dt><dd class="min-w-0 break-words font-medium">${v}</dd>`).join('')}</dl>`;
}
function Timeline(items) {
  return `<ol class="space-y-4">${items.map(([t, d, tone]) => `<li class="flex gap-3"><span class="${cx('mt-1.5 size-2 shrink-0 rounded-full', tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-orange-500' : tone === 'err' ? 'bg-red-500' : tone === 'now' ? 'bg-sky-500 ring-4 ring-sky-500/20' : 'bg-muted-foreground/40')}"></span><div class="text-sm"><p class="font-medium">${t}</p><p class="text-xs text-muted-foreground">${d}</p></div></li>`).join('')}</ol>`;
}
const checkList = items => `<ul class="grid gap-2 text-sm">${items.map(i => `<li class="flex gap-2">${icon('check', 'mt-0.5 size-4 shrink-0 text-muted-foreground')}<span>${i}</span></li>`).join('')}</ul>`;

/* ---------- public site chrome (existing best.serp.co header/footer, unchanged) ---------- */
function header(o = {}) {
  const auth = o.auth || 'out';
  const ob = 'hidden @sm:inline-flex items-center justify-center rounded-none text-sm font-bold h-9 px-4 border border-border hover:bg-accent transition-colors';
  const right = auth === 'out'
    ? `<a class="${ob}">Sign up / Sign in</a>`
    : `<a class="${ob}">Account</a><button class="hidden @sm:inline-flex items-center rounded-none text-sm font-bold h-9 px-4 hover:bg-accent">Sign out</button>`;
  return `<header class="border-b border-border/50 bg-background/80 backdrop-blur-lg">
    <div class="flex h-16 w-full items-center justify-between gap-3 px-4 @sm:gap-4 @sm:px-6">
      <div class="flex items-center gap-2"><button class="-ml-2 rounded-md p-2 hover:bg-muted @sm:hidden" aria-label="Open menu">${icon('menu', 'size-5')}</button><a class="whitespace-nowrap text-lg font-bold tracking-tight">SERP</a></div>
      <div class="hidden max-w-2xl flex-1 @md:block"><div class="relative"><div class="block w-full rounded-lg border border-input bg-background px-4 py-2 text-sm text-muted-foreground">Search products, categories, and descriptions...</div><span class="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground">${icon('search')}</span></div></div>
      <div class="flex items-center gap-2 @sm:gap-4"><button class="inline-flex size-9 items-center justify-center text-muted-foreground @md:hidden" aria-label="Toggle search">${icon('search', 'size-5')}</button><a class="inline-flex h-9 items-center justify-center rounded-none bg-foreground px-3 text-sm font-bold text-background @sm:px-4" aria-label="Submit">${icon('plus', 'size-4 @sm:hidden')}<span class="hidden @sm:inline">Submit</span></a>${right}</div>
    </div>
  </header>`;
}
function footer() {
  if (!UI.footer) return '';
  const col = (t, items) => `<div><h4 class="mb-4 text-sm font-bold uppercase tracking-wider text-muted-foreground">${t}</h4><ul class="space-y-2 text-sm">${items.map(i => `<li><a class="hover:text-foreground">${i}</a></li>`).join('')}</ul></div>`;
  return `<footer class="border-t border-border/50 bg-muted/30 py-12 @md:py-16"><div class="mx-auto w-full max-w-[1400px] px-4"><div class="grid grid-cols-1 gap-8 @md:grid-cols-6 @md:gap-12">
    <div class="space-y-4 @md:col-span-2"><h3 class="text-lg font-bold tracking-tight">SERP</h3><p class="text-sm text-muted-foreground">Software, AI tools, companies, resources, and SERP projects</p><div class="my-6 flex items-center gap-1">${['sun', 'github', 'chat', 'xlogo'].map(i => `<span class="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground">${icon(i, 'size-5')}</span>`).join('')}</div></div>
    <div class="grid grid-cols-1 gap-8 @md:col-span-4 @md:grid-cols-3">${col('Directory', ['Submit', 'Pricing', 'Contact'])}${col('Resources', ['Brands', 'Sponsor'])}${col('Legal', ['Legal', 'About', 'Privacy Policy', 'Terms of Service', 'Affiliate Disclosure', 'DMCA'])}</div>
  </div></div></footer>`;
}
/* Public page. o.clip limits the mobile frame to one phone screen so a bottom drawer is visible. */
function page(body, o = {}) {
  return `<div class="${cx('relative', o.clip && 'h-[780px] overflow-hidden @sm:h-auto @sm:overflow-visible')}">${header(o)}<main class="relative">${body}</main>${o.noFooter ? '' : footer()}${o.overlay || ''}</div>`;
}

/* ---------- dashboard shells ----------
   /account: dashboard-01 (Sidebar variant="inset", collapsible="offcanvas", Quick Create, NavUser, SiteHeader)
   /admin:   sidebar-07 (collapsible="icon", logo header, NavUser) with a breadcrumb header
   Mobile: the Sidebar becomes a Sheet (offcanvas) opened from the top bar trigger. */
const USERS = {
  account: { name: 'Maya Ortiz', email: 'maya@quillmate.app', ini: 'MO' },
  admin: { name: 'Devin Schumacher', email: 'devin@serp.co', ini: 'DS' }
};
function sbButton(inner, o = {}) {
  return `<a data-slot="sidebar-menu-button" data-active="${!!o.active}" class="${cx('flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>span:last-child]:truncate', o.lg ? 'h-12' : 'h-8', o.active ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground', o.cls)}">${inner}</a>`;
}
function sidebarInner(area, active, o = {}) {
  const u = USERS[area];
  const nav = area === 'admin'
    ? [['queue', 'Review queue', 'inbox', '6'], ['inbox', 'Inbox', 'msg', '3', true], ['listings', 'Listings', 'box'], ['orders', 'Orders', 'receipt'], ['admins', 'Admins', 'users']]
    : [['overview', 'Overview', 'dashboard'], ['submissions', 'Submissions', 'file', '3'], ['listings', 'Listings', 'box'], ['messages', 'Messages', 'msg', '2', true], ['settings', 'Settings', 'settings']];
  const icons = o.icons;
  const headerBtn = area === 'admin'
    ? sbButton(`<span class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">${serpMark('size-4')}</span>${icons ? '' : '<span class="grid flex-1 text-left text-sm leading-tight"><span class="truncate font-medium">SERP</span><span class="truncate text-xs">Admin</span></span>'}`, { lg: true, cls: icons ? 'justify-center !p-0 size-8 !h-8' : '' })
    : sbButton(`${serpMark('size-5')}<span class="text-base font-semibold">SERP</span>`, { cls: '!p-1.5' });
  const quick = area === 'account' ? `<div data-slot="sidebar-group" class="relative flex w-full min-w-0 flex-col p-2"><ul data-slot="sidebar-menu" class="flex w-full min-w-0 flex-col gap-1"><li class="flex items-center gap-2">${sbButton(`${icon('plusCircle')}<span>Submit a product</span>`, { cls: 'min-w-8 bg-primary text-primary-foreground hover:!bg-primary/90 hover:!text-primary-foreground' })}</li></ul></div>` : '';
  const items = nav.map(([k, l, ic, n, unread]) => `<li data-slot="sidebar-menu-item" class="relative">${sbButton(`${icon(ic)}${icons ? '' : `<span>${l}</span>`}`, { active: k === active, cls: icons ? 'justify-center size-8 !p-2' : '' })}${n && !icons ? `<span data-slot="sidebar-menu-badge" class="${cx('pointer-events-none absolute right-1 top-1.5 flex h-5 min-w-5 select-none items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums', unread ? 'bg-primary text-primary-foreground' : 'text-sidebar-foreground')}">${n}</span>` : ''}${n && unread && icons ? '<span class="absolute right-1 top-1 size-2 rounded-full bg-primary"></span>' : ''}</li>`).join('');
  const secondary = area === 'admin' ? [['ext', 'View best.serp.co']] : [['ext', 'View best.serp.co'], ['msg', 'Message us']];
  const userBtn = sbButton(`${Avatar(u.ini, { lg: true })}${icons ? '' : `<span class="grid flex-1 text-left text-sm leading-tight"><span class="truncate font-medium">${u.name}</span><span class="truncate text-xs text-muted-foreground">${u.email}</span></span>${icon(area === 'admin' ? 'chevsUD' : 'dotsV', 'ml-auto size-4')}`}`, { lg: true, active: o.menu, cls: icons ? 'justify-center !p-0 size-8 !h-8' : '' });
  return `<div data-slot="sidebar-header" class="flex flex-col gap-2 p-2">${headerBtn}</div>
    <div data-slot="sidebar-content" class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">${icons ? '' : quick}
      <div data-slot="sidebar-group" class="relative flex w-full min-w-0 flex-col p-2">${icons ? '' : `<div data-slot="sidebar-group-label" class="flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70">${area === 'admin' ? 'Admin' : 'Account'}</div>`}<ul data-slot="sidebar-menu" class="flex w-full min-w-0 flex-col gap-1">${items}</ul></div>
      ${icons ? '' : `<div data-slot="sidebar-group" class="relative mt-auto flex w-full min-w-0 flex-col p-2"><ul class="flex w-full min-w-0 flex-col gap-1">${secondary.map(([ic, l]) => `<li>${sbButton(`${icon(ic)}<span>${l}</span>`)}</li>`).join('')}</ul></div>`}
    </div>
    <div data-slot="sidebar-footer" class="relative flex flex-col gap-2 p-2">${userBtn}${o.menu ? `<div class="absolute bottom-2 left-full z-50 ml-2 hidden w-56 @md:block">${userMenu(area)}</div>` : ''}</div>`;
}
function userMenu(area) {
  const u = USERS[area];
  return Menu([
    { raw: `<div data-slot="dropdown-menu-label" class="p-0 font-normal"><div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">${Avatar(u.ini, { lg: true })}<div class="grid flex-1 text-left text-sm leading-tight"><span class="truncate font-medium">${u.name}</span><span class="truncate text-xs text-muted-foreground">${u.email}</span></div></div></div>` },
    '-',
    area === 'admin' ? { t: 'Switch to Account', icon: 'userCircle', focus: true } : { t: 'Account settings', icon: 'userCircle', focus: true },
    area === 'admin' ? { t: 'Admin settings', icon: 'settings' } : { t: 'View best.serp.co', icon: 'ext' },
    '-',
    { t: 'Sign out', icon: 'logout' }
  ], { cls: 'min-w-56 rounded-lg' });
}
function shell(area, active, crumbs, body, o = {}) {
  const inset = area === 'account';
  const desktopSidebar = `<aside data-slot="sidebar" data-variant="${inset ? 'inset' : 'sidebar'}" data-collapsible="${o.icons ? 'icon' : ''}" class="${cx('relative hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground @md:flex', o.icons ? 'w-12' : 'w-64', !inset && 'border-r border-sidebar-border')}">${sidebarInner(area, active, { menu: o.menu, icons: o.icons })}</aside>`;
  const topbar = inset
    ? `<header class="flex h-12 shrink-0 items-center gap-2 border-b"><div class="flex w-full items-center gap-1 px-4 @lg:gap-2 @lg:px-6">${Button('', { v: 'ghost', size: 'icon', icon: 'panelLeft', cls: '-ml-1 !size-7', sr: 'Toggle Sidebar' })}${Separator(true, 'mx-2')}${Breadcrumb(crumbs)}<div class="ml-auto flex items-center gap-2">${Button('View site', { v: 'ghost', size: 'sm', iconR: 'ext', cls: 'hidden @sm:flex' })}</div></div></header>`
    : `<header class="flex h-14 shrink-0 items-center gap-2 border-b"><div class="flex w-full items-center gap-2 px-4">${Button('', { v: 'ghost', size: 'icon', icon: 'panelLeft', cls: '-ml-1 !size-7', sr: 'Toggle Sidebar' })}${Separator(true, 'mr-2')}${Breadcrumb(crumbs)}<div class="ml-auto">${Button('View site', { v: 'ghost', size: 'sm', iconR: 'ext', cls: 'hidden @sm:flex' })}</div></div></header>`;
  const main = `<main data-slot="sidebar-inset" class="${cx('relative flex w-full min-w-0 flex-1 flex-col bg-background', inset && '@md:m-2 @md:ml-0 @md:rounded-xl @md:shadow-sm')}">${topbar}<div class="${cx('flex flex-1 flex-col', o.flush ? '' : 'gap-4 p-4 @lg:gap-6 @lg:p-6')}">${body}</div></main>`;
  const sheet = o.sheet ? `<div class="absolute inset-0 z-40 bg-black/80 @md:hidden"></div><div data-slot="sheet-content" data-mobile="true" class="absolute inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar text-sidebar-foreground shadow-lg @md:hidden">${sidebarInner(area, active, {})}<div class="px-2 pb-2">${userMenu(area)}</div></div>` : '';
  return `<div data-slot="sidebar-wrapper" class="${cx('relative flex w-full', inset && 'bg-sidebar', o.clip ? 'h-[780px] overflow-hidden @md:h-auto @md:min-h-[760px] @md:overflow-visible' : 'min-h-[760px]')}">${desktopSidebar}${main}${sheet}${o.overlay || ''}</div>`;
}
/* page heading inside a dashboard */
function pageHead(p, title, chips, meta, actions) {
  return `<div class="flex flex-col gap-4 @lg:flex-row @lg:items-start @lg:justify-between"><div class="flex items-start gap-3">${p ? logo(p, 48) : ''}<div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h1 class="text-2xl font-semibold tracking-tight">${title}</h1>${chips || ''}</div>${meta ? `<p class="mt-1 text-sm text-muted-foreground">${meta}</p>` : ''}</div></div>${actions ? `<div class="flex flex-wrap gap-2">${actions}</div>` : ''}</div>`;
}
