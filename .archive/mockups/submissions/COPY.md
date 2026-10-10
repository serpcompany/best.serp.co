# Submissions mockup copy: checkout, claim, listing page, orders

Visible copy from the [recovered #70 mockups](./README.md) (revision 5), extracted from the
rendered page at desktop width, per screen and state. Example products, people, IDs, dates and
amounts are fictional. Swap in real values; keep everything else word for word, including the
curly apostrophes and quotes. The mobile drawer for the claim dialog uses the same strings.

Later approved deviations on [#70](https://github.com/serpcompany/best.serp.co/issues/70) take
precedence over this file. For example,
[the post-approval #102 copy](https://github.com/serpcompany/best.serp.co/issues/70#issuecomment-6012117608)
changes the badge panel's checks-left line.

Notation: `Title`, `Body`, `Alert`, `Badge`, `Button` and `Link` name the element. `Field` gives
a label, then its example value in brackets. Buttons are listed in screen order.

## Screen 4: paid checkout (`/submit/<id>/checkout`)

Order summary item, shared by handoff, confirming, cancelled and failed:
`Paid listing: Quillmate` / `One-off payment, USD. The listing is permanent.` / `$49.00`.

Order details list, shared by both success states: `Order` ORD-1042 · `Amount` $49.00 USD,
one-off · `Status` Badge `Paid` · `Receipt` Emailed to maya@quillmate.app by Stripe.

### 4a. Handoff to Stripe (`/submit/s_4f9k2c/checkout/`)

- Title (with spinner): Taking you to Stripe
- Body: You’ll pay on Stripe’s checkout page and come straight back here.
- Order summary item
- Heading: After you pay. Then three numbered steps (title, then text):
  1. We run automatic checks: The URL is public and loads, isn’t already listed, and passes our
     safe-fetch rules.
  2. Checks pass: Quillmate goes live: Within about a minute, at /products/quillmate.app/.
  3. A reviewer still looks at it: If it’s rejected for anything other than prohibited content,
     you get a full refund automatically.
- Buttons: Continue to checkout (external-link icon) · Back to options

### 4b. Stripe page (context only, Stripe-hosted, not ours)

Wireframe label: Stripe-hosted page · wireframe for context, not our UI. Stripe shows SERP,
Paid listing: Quillmate, $49.00, One-off payment, then Email, Card information, Cardholder name and
Pay $49.00.

### 4c. Return: confirming (`/submit/s_4f9k2c/checkout/return/?session_id=…`)

- Title (with spinner): Confirming your payment…
- Body: This usually takes a few seconds. You can keep this page open or check your account later.
- Order summary item

### 4d. Success: live and in review (same return URL)

- Alert (success): Payment received / Thanks. Quillmate passed our automatic checks.
- Title: Quillmate is live on SERP
- Description: https://best.serp.co/products/quillmate.app/
- Alert (info): Still in review / Our team reviews every paid listing. If we reject Quillmate for
  anything other than prohibited content, you get a full refund automatically.
- Order details list
- Buttons: View your listing (external-link icon) · Go to my account
- Line below the card: The badge is optional for paid listings. Link: Get the badge code

### 4e. Success: checks failed (same return URL)

- Alert (warning): Payment received, waiting for review / Our checks couldn’t load
  https://quillmate.app/ (no response within 8 seconds).
- Title: Quillmate goes live after review
- Body: A reviewer will look at it before it’s published. You don’t need to do anything. If it’s
  rejected for anything other than prohibited content, you get a full refund automatically.
- Order details list
- Button: Go to my account

### 4f. Cancelled (`/submit/s_4f9k2c/checkout/cancelled/`)

- Title: Checkout cancelled
- Body: You weren’t charged. Quillmate is saved in your account, so you can pick it up any time.
- Order summary item with Badge: Not paid
- Buttons: Return to checkout · Back to options

### 4g. Failed (same return URL)

- Alert (destructive): Payment didn’t go through / Stripe declined the payment, so you weren’t
  charged.
- Title: Try the payment again
- Body: Quillmate is saved. Nothing is published until a payment succeeds or the badge is
  verified.
- Order summary item with Badge: Failed; below it: Order ORD-1043
- Buttons: Try again · Back to options

## Screen 8: claim flow (dialog on `/products/<slug>/`)

Every step shows the dialog title `Claim Brieflow`, the description `Prove you work at Brieflow to
manage this listing.` and a progress bar labelled with the step name and `Step N of 4`. The step
names are Method, Work email, Code, then Badge or Payment.

### 8a. Method (Step 1 of 4)

- Choice card (selected): Install the badge (free) / Add our badge to brieflow.ai with a dofollow
  link to this listing. We check it weekly. If it’s removed, you lose ownership and the listing
  stays up.
- Choice card: Skip the badge: $49 one-off / No badge needed, and ownership doesn’t depend on one.
- Help text: Either way, you’ll confirm an email address at **brieflow.ai**.
- Buttons: Cancel · Continue

### 8b. Work email (Step 2 of 4)

- Field: Your email at brieflow.ai [jordan@brieflow.ai]
- Help text: We’ll send a 6-digit code. Personal addresses like Gmail or Outlook can’t be used.
- Buttons: Back · Send code

### 8c. Code (Step 3 of 4)

- Label: Code sent to jordan@brieflow.ai
- Six-slot code input (two digits typed)
- Help text: It expires in 10 minutes. Didn’t get it? Resend in 0:51
- Buttons: Back · Verify

### 8d. Finish: badge (Step 4 of 4, "Badge")

- Body: Paste this into the HTML of https://brieflow.ai/ and keep the link dofollow.
- Badge preview (Featured on SERP), then the embed code:

  ```html
  <a href="https://best.serp.co/products/brieflow.ai/" target="_blank" rel="noopener noreferrer" title="Featured on SERP">
    <img src="https://best.serp.co/badge/featured-on-serp.co-light.svg" alt="Featured on SERP" width="200" height="50" />
  </a>
  ```

- Button: Copy code. Beside it: 10 of 10 checks left
- Buttons: Back · Verify badge and claim

### 8e. Finish: payment (Step 4 of 4, "Payment")

- Item: Paid claim: Brieflow / One-off payment, USD / $49.00
- Help text: jordan@brieflow.ai is confirmed. You become the owner as soon as the payment goes
  through on Stripe.
- Buttons: Back · Continue to payment: $49

### 8f. Success

- Title: You now manage Brieflow
- Description: It’s in your account. Edits you make are reviewed before they go live.
- Alert: Keep the badge on brieflow.ai / We check it weekly. If it’s missing on two checks about
  24 hours apart, ownership is removed. The listing stays up.
- Buttons: Edit listing · Open account
- Behind the dialog, the listing now shows the Verified owner badge (9b).

### 8g–8k. Errors

| State | Where | Error text (replaces the help text) |
| --- | --- | --- |
| Webmail | Step 2, value [jordan.lee@gmail.com] | Gmail addresses can’t confirm you work at Brieflow. Use an address at brieflow.ai. |
| Domain mismatch | Step 2, value [jordan@brieflow.io] | That address is at brieflow.io. Use an email at brieflow.ai (subdomains like team.brieflow.ai work too). |
| Code expired | Step 3, code 730514 | This code has expired. Send a new one. Buttons: Back · Send a new code |
| Too many attempts | Step 3, code 730514 | Too many incorrect codes. Wait 15 minutes, then request a new code. Verify is disabled. |

Already owned (replaces the whole dialog):

- Title: Brieflow already has an owner
- Description: Someone has already verified that they own this listing.
- Body: If you think that’s a mistake, message us. We’ll check with the current owner and can move
  the listing to you.
- Buttons: Close · Message us

## Screen 9: listing page changes (`/products/<slug>/`)

- 9a. Visitor, unclaimed. In the sidebar card under Category: `Work at Brieflow?`, then
  Link: Claim this listing.
- 9b. Visitor, verified owner. Next to the name: Badge `Verified owner`, with the tooltip
  `The maker verified ownership of this listing`. No claim link.
- 9c–9e. Owner only: an alert above the hero, plus the Verified owner badge.

| State | Alert title | Alert text | Buttons |
| --- | --- | --- | --- |
| 9c. Owner view | You manage this listing | Only you can see this. Badge passing, last checked Mon, Oct 5. | Edit listing · Open account |
| 9d. Edits in review | Your edits are in review | Only you can see this. Visitors see the current version until a reviewer approves your changes. | View pending edits |
| 9e. Badge warning (warning) | The badge is missing on brieflow.ai | Only you can see this. We recheck around Wed, Oct 7, 09:00 UTC. Put the badge back before then to keep ownership; the listing stays up either way. | Check badge now · Get badge code |

9f. Unpublished (`/products/scrapebird.dev/`, HTTP 410 Gone):

- Title: Scrapebird is no longer listed
- Body: This listing was removed from SERP. Browse other products in Link: No Code Web Scrapers.
- Button: Browse No Code Web Scrapers
- Item: Is this your product? / Sign in to relist it on SERP. / Button: Relist it

## Screen 13: admin Orders (`/admin/orders/`)

- Breadcrumb: Admin › Orders. Title: Orders. Subtitle: Paid listings and paid claims. $49.00 USD,
  one-off.
- Tabs with counts: All 7 · Paid 4 · Refunded 1 · Pending 1 · Failed 1
- Filter placeholder: Filter by order, email, or product…
- Columns: Order · Date (UTC) · Customer · Kind · Item · Amount · Status · Stripe
- Kinds: Paid listing, Paid claim. Status badges: Pending, Paid, Refunded, Failed. Notes under a
  status: Rejected: prohibited · Auto refund on reject · Card declined · Badge passing
- Footer: 7 orders · Rows per page 10 · Page 1 of 1
- 13a. Row menu: View in Stripe · Copy order ID · Open listing · Refund… (destructive, after a
  separator)

13b. Refund confirm, no badge (alert dialog):

- Title: Refund $49.00 and unpublish Voxbloom?
- Description: Refunds the full amount to hello@voxbloom.fm through Stripe. This can’t be undone.
- Order: ORD-1041 · Paid listing · Voxbloom. Amount: $49.00 to the original payment method.
- Listing now: Badge `Live (paid, in review)`. Listing after refund: Badge `Unlisted`, then
  `URL returns 410`.
- Alert (warning): Voxbloom has no passing badge / A refunded listing stays up only if its badge is
  passing, as a free listing. Voxbloom has no badge, so it’s unpublished.
- Field: Reason for the activity log [Customer asked for a refund within 24 hours.]
- Buttons: Cancel · Refund and unpublish (destructive)

13c. Refund confirm, passing badge (alert dialog):

- Title: Refund $49.00 for Formsy?
- Description: Refunds the full amount to hi@formsy.app through Stripe. This can’t be undone.
- Order: ORD-1036 · Paid listing · Formsy. Amount: $49.00 to the original payment method.
- Listing now: Badges `Live` `Paid`. Listing after refund: Badges `Live` `Free`.
- Alert (success): Formsy keeps a passing badge / It stays live as a free listing and joins the
  weekly badge checks. If the badge later goes missing, the usual warning and recheck apply.
- Field: Reason for the activity log [Duplicate charge.]
- Buttons: Cancel · Refund, keep live as free (destructive)

13d. Refunded: tabs read Paid 3 · Refunded 2. Row ORD-1041 shows `Refunded` with the note
`Listing unpublished (no badge)`. Toast: `Refunded $49.00 for ORD-1041` / `Voxbloom was unpublished
(no passing badge). Logged under devin@serp.co.`

## Related emails (screen 15)

All four come from `SERP Directory <noreply@mail.serp.co>` with no Reply-To and the SERP
wordmark. Each has a collapsed plain-text part built from the same strings. Shared footer:
`SERP Directory · best.serp.co` / `This address isn’t monitored. Reply from your dashboard:
https://best.serp.co/account/messages/` / reason line (below). Under a CTA:
`Or open <CTA URL>`.

### Claim code (to jordan@brieflow.ai)

- Subject: 730514 is your SERP code to claim Brieflow
- Preview: Confirm you work at Brieflow.
- Heading: Confirm your email to claim Brieflow
- Body: A SERP account is claiming the Brieflow listing and entered this address to show they work
  there. Enter this code to confirm:
- Code block: 730 514
- Body: It expires in 10 minutes. If you didn’t ask for this, ignore this email. Nobody can claim
  Brieflow without the code.
- No CTA. Reason: You’re getting this because this address was entered to claim a listing on
  best.serp.co.

### Paid: live after payment (to hello@voxbloom.fm)

- Subject and heading: Voxbloom is live on SERP / Voxbloom is live
- Preview: Payment received. Your listing is published and in review.
- Body: Thanks for your payment of $49.00. Voxbloom passed our automatic checks and is now listed
  on SERP:
- Box (bold): https://best.serp.co/products/voxbloom.fm/
- Body: A reviewer still looks at every paid listing. If we reject it for anything other than
  prohibited content, you get a full refund automatically.
- Body: The badge is optional for paid listings.
- CTA: View your listing (https://best.serp.co/products/voxbloom.fm/)

### Held: payment received, in review (to team@kiddotutor.com)

- Subject: Payment received: Kiddo Tutor is in review
- Preview: Kiddo Tutor goes live after a reviewer looks at it.
- Heading: Kiddo Tutor goes live after review
- Body: Thanks for your payment of $49.00.
- Body: Our automatic checks couldn’t load https://kiddotutor.com/ (the connection timed out), so
  Kiddo Tutor isn’t live yet. A reviewer will look at it before it’s published. You don’t need to
  do anything.
- Body: If it’s rejected for anything other than prohibited content, you get a full refund
  automatically.
- CTA: View submission (https://best.serp.co/account/submissions/s_7tq20z/)

### Refund: rejected, paid and refunded (to team@kiddotutor.com)

- Subject: Kiddo Tutor wasn’t approved, and we’ve refunded you
- Preview: Your $49.00 payment has been refunded.
- Heading: Kiddo Tutor wasn’t approved
- Body: A reviewer looked at Kiddo Tutor and couldn’t approve it.
- Box: **Reason:** kiddotutor.com still didn’t load when we reviewed it (the connection timed
  out).
- Body: We’ve refunded **$49.00** to your original payment method. It can take 5 to 10 business
  days to show up.
- Body: You can fix the site, edit the submission, and send it again.
- CTA: Open submission (https://best.serp.co/account/submissions/s_7tq20z/)

The paid, held and refund emails share the reason line `You’re getting this because you have an
account on best.serp.co.` The mockups have no separate email for a refund issued from Orders (13).
