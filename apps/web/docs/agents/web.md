# Website working guide

`apps/web` is best.serp.co: a Next.js app served from one Cloudflare Worker through OpenNext,
reading its catalog from D1. This guide covers how the site looks and how to change it. The
rules for code and data are in [`apps/web/AGENTS.md`](../../AGENTS.md) and the root
[`AGENTS.md`](../../../../AGENTS.md).

best.serp.co shares its base with zenbujapanese.com, serplists.com, keybumps.com and serp.co
(#253): stock shadcn, serplists' layout blocks and the same page templates. A difference between
the sites belongs in the theme's token values, not in a component.

## Where the rest is

| Topic | Read |
|---|---|
| Local Worker, local D1, accounts and email locally | [Development](../../../../docs/development.md) |
| Environments, workflows, releases and caching after a deploy | [Deploy runbook](../../../../docs/deploy-runbook.md) |
| `wrangler.jsonc`, bindings, the Worker entry and the edge cache | [Architecture](../../../../docs/architecture.md) |
| Worker vars and secrets | Vars are set in `wrangler.jsonc` and typed in the generated `cloudflare-env.d.ts` (`pnpm cf-typegen`); secrets and local-only vars are declared by hand in `cloudflare-env-secrets.d.ts`. Each is described in its feature's doc |
| Checks, runtime evidence and worktrees | [Harness](../../../../docs/harness.md) |
| Sign-in, the dashboard shell and the admin gate | [Accounts](../../../../docs/accounts.md) |
| `/account` screens | [Submitter dashboard](../../../../docs/account-dashboard.md) |
| `/admin` screens | [Admin panel](../../../../docs/admin-panel.md) |

## Design system

- **Components.** shadcn/ui, style `base-nova` on Base UI, base color `neutral`, `lucide` icons,
  no registries (`apps/web/components.json`, the same file the other sites use). The components
  live in `src/components/ui/`.
- **Styling.** Tailwind CSS 4 through `src/app/globals.css`, with `tw-animate-css`,
  `shadcn/tailwind.css` and `@tailwindcss/typography`. There is no `tailwind.config`. Merge
  classes with `cn` (`src/lib/utils.ts`).
- **Fonts.** Geist and Geist Mono through `next/font/google` (`src/lib/fonts.ts`), as
  `--font-sans` and `--font-geist-mono`.
- **Light and dark.** `next-themes` (`components/layout/theme-provider.tsx`) puts the `dark`
  class on `<html>` and follows the system until a visitor picks a theme. The header's account
  menu holds the Light, Dark and System row (`ThemeMenuRow`); the phone menu and the dashboards
  have `ThemeToggle`.
- **Long text.** A listing's Markdown renders in `prose` through `components/content/
  mdx-components.tsx`. The legal pages use `.prose-docs` from `globals.css`, as serp.co does.

### Tokens

Every color and the radius are CSS variables in `globals.css`: light values in `:root`, dark in
`.dark`, mapped to Tailwind in `@theme inline`. Use them through their classes (`bg-background`,
`text-muted-foreground`, `border-border`).

| Token | What it is for |
|---|---|
| `background`, `foreground` | The page and its text |
| `card`, `popover` (each with `-foreground`) | Cards, and menus, popovers and dialogs |
| `primary`, `primary-foreground` | The main action: buttons, the current item |
| `secondary`, `accent` (each with `-foreground`) | Quieter buttons, hover and selected rows |
| `muted`, `muted-foreground` | Panels and tiles behind content, and secondary text |
| `destructive` | Deleting, refusing and errors (`buttonVariants({ variant: 'destructive' })`) |
| `success`, `warning`, `info` (each with `-foreground`) | Status (#184): live or verified, needs attention or unofficial, in review or informational. The dashboards show a record's status with `StatusChip` (`components/status/status-chip.tsx`) |
| `border`, `input`, `ring` | Borders, form-control borders, focus rings |
| `chart-1` to `chart-5` | Charts (none yet) |
| `sidebar-*` | The dashboards' sidebar |
| `radius` | shadcn's stock radius (`0.625rem`); the `--radius-*` steps derive from it |

The status tones are best.serp.co's only addition to the stock tokens. Their text reads at WCAG
AA on `background` and `muted` in both themes. Add a token, in both themes, when a design needs a
new color.

## Building UI

These are the rules the other SERP sites follow (zenbujapanese.com's UI components, serplists'
`docs/DESIGN.md`):

- **Use the stock component.** A table is `Table`, a set of views is `Tabs` or `ToggleGroup`, a
  question list is `Accordion`, an empty list is `Empty`, an action is `Button`. Add a missing one
  with `pnpm shadcn <name>` from the repository root, keep the file as the CLI wrote it apart from
  what Biome requires, and add its name to `STOCK_UI` in `scripts/theme-color-guard.test.ts`,
  which otherwise fails. Never hand-roll a pill, chip, segmented control, table or check box that
  a stock component covers.
- **Don't restyle it.** A `className` on a stock component may lay it out (width, grid placement,
  margin), but not change its size, padding, radius, border, color, type size or density. Use its
  variants and sizes. A link that looks like a button takes `buttonVariants()`. Two kinds of
  class are not restyling: those that came with a block copied as it is (dashboard-01's status
  chip, the data table's toolbar, serp.co's docs badges), which stay as copied; and status tones,
  since shadcn ships no success, warning or info variants: they go on `Badge` and `Alert` as
  token classes (`text-warning`, `border-warning/40`), as the product page's Unofficial badge and
  the dashboards' notices do.
- **Colors come only from the tokens.** No hex or rgb values and no Tailwind palette classes
  (`white`, `gray-500`) in components.
- **Copy the reference blocks.** A new page or section starts from the layout blocks below, or
  from the reference site's block it would copy (serplists, serp.co, zenbujapanese.com, read from
  their checkouts). Copy it as it is, and name every adaptation in the PR. Don't invent UI or copy.

Two checks enforce the first and third rules: `scripts/raw-control-guard.test.ts` (#188) fails
on a raw `<button>`, `<input>`, `<select>` or `<textarea>`, and `scripts/theme-color-guard.test.ts`
(#183) on a palette class or a literal color. Each keeps a per-file baseline that may only go
down, and both baselines are empty.

### Layout blocks

The public pages are composed from the blocks in `src/components/layout/`, each built from stock
components; each file's doc comment says what it draws.

| Use | For |
|---|---|
| `SiteChrome` | Nothing to add: the `(site)` layout and the 404 already wrap pages in the header, footer and `<main>` |
| `PageContainer`, `PageSection` (`page-shell.tsx`) | Every page's width and its bands of vertical spacing |
| `PageHero` | A page's opening and its `h1` |
| `Section`, `SectionHeader` | A titled band with an optional "View all" link |
| `CardGrid` with `ListCard` | Lists of links: categories, contact options, brands |
| `DetailPageLayout` | One record's page, such as the product page |
| `PageBreadcrumb` | A detail page's trail, when the page's own JSON-LD carries the `BreadcrumbList` (the product page) |
| `SiteBreadcrumb` | A trail that writes its own `BreadcrumbList` (the categories pages); `BreadcrumbJsonLd` from the same file writes only the JSON-LD, for pages whose layout draws the trail (legal) |
| `PageShell` (`docs-page-shell.tsx`) | Long-form text pages, after serp.co's docs layout (legal) |
| `Toolbar`, `SearchField` | The controls over a list |
| `IconTile` | An icon on a muted square, as decoration |

Listing cards are `components/llm/listing-card.tsx` in `LLMGrid`, on `CardGrid`. An empty list or
search is `components/directory/empty-state.tsx`: the stock `Empty`, as serplists' `PageEmptyState`.

## Page patterns

| Page | Route | Built from |
|---|---|---|
| Home, and `/products/` page by page | `/`, `/products/?page=N` | `components/home/home-page.tsx`: `PageHero` with the listing count and Submit, Featured and Recently added in `LLMGrid`, then the browse list with its filter and the page links |
| Categories | `/products/categories/` | `PageHero`, then a `ListCard` per category in `CardGrid` |
| Category | `/products/categories/<category>/` | `components/category-routes/category-page.tsx`: breadcrumb, `PageHero`, the sortable listings, the page links |
| Product | `/products/<slug>/` | `components/website-routes/detail-page.tsx` on `DetailPageLayout`: the logo, name, description, badges, Visit Site and favorite in the header, the featured-on badge and claim link in the panel, then the content, links, FAQs, browse-more and related listings |
| Search | `/search/` | `components/search/index-page.tsx`: `PageHero` with the page's search field, then the results |
| About | `/about/` | `components/static-pages/about-page.tsx`: `PageHero`, then `SectionHeader`s over `ListCard`s in `CardGrid` |
| Brands | `/brands/` | `components/static-pages/brands-page.tsx`: `PageHero` over `ListCard`s in `CardGrid` |
| Contact, sponsor | `/contact/`, `/sponsor/` | Their route files: `PageHero` over a `ListCard` in a one-column `CardGrid` |
| Pricing | `/pricing/` | `PageHero`, then serplists' `PlanCard` (a stock `Card`) per plan in `CardGrid` |
| Legal | `/legal/`, `/legal/<policy>/` | `PageShell`'s docs layout with `LegalNav`; the index is a `ListCard` per policy |
| Sign in | `/login/` | `components/auth/login-card.tsx` in serplists' `AuthCard` |
| 404 | any unknown path | serp.co's not-found page (`NotFoundContent`) |

The submit flow (`/submit/…`) keeps its own screens. The admin review page previews a listing in
the product page's header (`components/admin/mini-listing.tsx`).

Public URLs are part of the SEO contract: changing one needs a permanent redirect
(`src/lib/routing/redirects.ts`).

## Dashboards

`/account` and `/admin` share the shadcn sidebar shell in `components/dashboard/` (its parts are
in [Accounts](../../../../docs/accounts.md)). Their UI rules are serp's
[dashboard UI rules](https://github.com/serpcompany/serp/blob/main/docs/engineering/websites/features/submissions/account-dashboard.md#ui-rules),
from best.serp.co's own review: start from the stock blocks (dashboard-01, sidebar-07) and keep
their structure; show unbuilt items with a "Soon" badge, never greyed out; put `Empty` inside a
`Card` under a visible heading; give every page a heading and a description; and status tones are
classes on `Alert` and `Badge`. The owner-approved #70 mockups and their copy
(`.archive/mockups/submissions/`) are the contract for those screens: a visible change needs the
owner's re-approval.

## Checking a UI change

- Look at each changed page at 1440 and 390 px wide, in light and dark: no sideways scrolling,
  visible focus, AA contrast.
- Publish the before and after captures as a private review page and link it from the PR.
- Cover changed behavior with Playwright (`apps/web/e2e/`). CI runs every spec there against the
  built Worker, except the opt-in `visual.spec.ts` and `agent-capture.spec.ts`; a light or dark
  change most likely touches `theme.spec.ts`.
