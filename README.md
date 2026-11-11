# emdash-memberships

Member accounts for [EmDash](https://github.com/emdash-cms/emdash) sites on Cloudflare: passwordless magic-link sign-in, plans and entitlements, Stripe subscriptions and one-time purchases with trials and coupons, revenue reporting, lifecycle emails, comp time for rewards and giveaways, and a Members area in the EmDash admin.

- **Sign-in by email link.** No passwords. Links are single-use, expire in 15 minutes, and are rate-limited per address and per IP.
- **Free and Pro plans.** `Astro.locals.member.plan` tells every page what the visitor may see.
- **Stripe, optional.** Checkout, the Customer Portal, and a webhook handler that turns payments, refunds and disputes into access.
- **Comp time.** Give someone Pro for N days without Stripe, once per idempotency key, stacking end to end.
- **Plans and entitlements.** Any number of plans, each granting entitlements your pages check with `can(member, "archive")`.
- **Members admin.** An optional EmDash plugin adds a Members area to `/_emdash/admin`: plans and prices synced to Stripe, coupons, revenue (MRR, churn, conversion), member management with plan changes and comp time, and lifecycle email settings. Plus MCP tools for agents.
- **Lifecycle emails.** Welcome, failed payment, trial ending, cancellation, ended and win-back, plus gift and team emails, queued from webhooks and sent by a scheduled job.
- **Access rules.** Gate collections, topics, entries or paths in the admin, with free windows, free flags and drip, and drop-in Astro components for the paywall, pricing table and account page.
- **Gifts, teams, downloads and limited offers.** Sell gift memberships and per-seat team plans, protect files in R2, and cap an offer at N members or a date.
- **Cancel flow.** Ask why, offer a coupon, a pause or a switch, and see why people leave.
- **Events, webhooks, import/export.** Signed webhooks for every change, CSV import from other platforms with Stripe customer linking, CSV export, notes and an audit trail.
- **Runs on D1.** Tables are created on first use. No migration step.

These are site visitors (readers, subscribers). They're separate from EmDash staff users, who sign in to `/_emdash/admin`.

## Requirements

- An EmDash site on Astro with the Cloudflare adapter and a D1 database (the default EmDash Cloudflare setup).
- For email: Cloudflare Email Service (`send_email` binding), or any provider through a small `EmailTransport` adapter.
- For payments: a Stripe account and the `stripe` package (v18 or later).

## Install

```bash
npm install emdash-memberships
```

Or straight from GitHub:

```bash
npm install github:ryanedick/emdash-membership
```

Add `stripe` too if you'll take payments: `npm install stripe`.

## Quick start (about 10 minutes)

Every file below is in [`examples/astro`](./examples/astro) ready to copy. Pages are deliberately unstyled; wrap them in your site's layout.

### 1. Wire it up once

```ts
// src/lib/members.ts
import { env } from "cloudflare:workers";
import { cloudflareEmailTransport, devLinkSender, transportLoginSender } from "emdash-memberships";
import { membershipsAstro } from "emdash-memberships/astro";

export const members = membershipsAstro({
	db: () => env.DB,
	sender: () =>
		import.meta.env.DEV
			? devLinkSender() // logs the link; /login/check shows it
			: transportLoginSender({
					transport: cloudflareEmailTransport(env.EMAIL),
					from: { email: "signin@mail.example.com", name: "Example" },
					siteName: "Example",
				}),
	dev: import.meta.env.DEV,
});
```

### 2. Middleware and types

```ts
// src/middleware.ts
import { members } from "./lib/members";
export const onRequest = members.middleware;
```

Already have middleware? `export const onRequest = sequence(members.middleware, yourMiddleware);` (from `astro:middleware`).

```ts
// src/env.d.ts
declare namespace App {
	interface Locals {
		member?: import("emdash-memberships").Member;
	}
}
```

### 3. Three one-line API routes

```ts
// src/pages/api/auth/login.ts
import { members } from "../../../lib/members";
export const POST = members.loginRoute;
```

Do the same for `verify.ts` (`members.verifyRoute`) and `logout.ts` (`members.logoutRoute`).

### 4. Pages

| Page | What it does |
| --- | --- |
| `/login` | A form posting `email` (and optional `next`) to `/api/auth/login`. Errors come back as `?error=email\|rate\|send\|verify\|expired`. |
| `/login/check` | "Check your inbox". In dev, `?dev=` holds the link. |
| `/login/verify` | Calls `await members.peekLoginLink(Astro)`, then shows a **Sign in** button that posts the token to `/api/auth/verify`. |
| `/account` | Anything you like, using `Astro.locals.member`. |

The verify page uses a button rather than signing in on GET, so email security scanners that open links can't use up the token.

### 5. Gate content

```astro
---
const member = Astro.locals.member;
const isPro = member?.plan === "pro";
---
{isPro ? <article set:html={body} /> : <a href="/pricing">Go Pro to read this</a>}
```

### 6. Email (production)

1. Add the binding to `wrangler.jsonc`, then run `wrangler types`:

   ```jsonc
   "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["signin@mail.example.com"] }]
   ```

2. Onboard the sending domain (the zone must use Cloudflare DNS):

   ```bash
   npx wrangler email sending enable mail.example.com
   ```

   DNS records take 5 to 15 minutes. The `from` address must be on that domain.

That's sign-in done. The rest is optional.

## Options

`membershipsAstro(config)`:

| Option | Default | |
| --- | --- | --- |
| `db` | required | D1 binding, or a function returning it |
| `sender` | required | A `LoginEmailSender`, or a function returning one |
| `dev` | `false` | Show the sign-in link on the check page. Pass `import.meta.env.DEV`. |
| `cookieName` | `mbr_session` | Session cookie |
| `skipPaths` | `["/_emdash"]` | Paths the middleware ignores |
| `clientIp` | `cf-connecting-ip` header | Used for per-IP rate limits |
| `verifyHuman` | none | `(form, ip) => boolean`, e.g. a Turnstile check |
| `paths` | `/login`, `/login/check`, `/account`, `/`, `/pricing`, `/billing/success` | Redirect targets used by the routes |
| `options` | | `linkTtlMinutes` (15), `sessionTtlDays` (30), `maxLinksPerEmailPerHour` (5), `maxLinksPerIpPerHour` (20), `verifyPath` (`/login/verify`) |

The login form also treats a filled-in `website` field as a bot (honeypot) and pretends to succeed.

## Plans and entitlements

A **plan** grants **entitlements**: plain strings your pages check, like `archive` or `courses`. Two plans are built in: `free` (everyone gets its entitlements) and `pro` (grants `pro`). Add more in the admin (**Members → Plans & prices**) or in code with `savePlan`.

```ts
import { can } from "emdash-memberships";

const member = Astro.locals.member; // plans and entitlements are loaded with the session
if (can(member, "archive")) {
	// show the full tip
}
```

A member holds a plan while one of these is true:

- a subscription to one of the plan's prices is active, trialing or past due;
- they bought a one-time price that grants early access;
- they've been given time on it (`grantProTime({ email, days, plan, key })`).

Their entitlements (the free plan's plus every held plan's) are cached per member, so a page view stays one query. `member.plan` is still `"pro"` while any paid plan is held, so 0.2 code keeps working.

## Stripe (optional)

1. **Keys, in the admin.** Open **Members → Connections**, paste a Stripe secret key and press **Create webhook in Stripe**. The plugin registers the webhook endpoint with every event it handles and saves its signing secret. Both are stored encrypted by EmDash (with the site's `EMDASH_ENCRYPTION_KEY`) and are never shown again. Use a **restricted** key with write access to Customers, Checkout Sessions, Customer portal, Subscriptions, Products, Prices, Coupons, Promotion codes and Webhook Endpoints, and read access to Invoices, Charges and Payment Intents. **Test connection** checks it.

   Prefer environment variables? `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` still work. A key saved in the admin takes over from them.
2. **Prices:** in the admin (**Plans & prices**: each plan becomes a Stripe Product, each price a Stripe Price with a lookup key), or import Stripe Prices you already have (**Import prices**).
3. **Wire it up.** `createBillingFromSettings` reads the keys from the admin (or the environment), and returns null until a key is set, so the routes answer "unavailable" instead of failing:

   ```ts
   // src/lib/billing.ts
   import { env } from "cloudflare:workers";
   import { createBillingFromSettings } from "emdash-memberships/stripe";
   import { members } from "./members";

   export const billing = members.billingRoutes({
   	billing: () => createBillingFromSettings({ db: env.DB }),
   });
   ```

   (`createBilling({ db, stripe, webhookSecret })` is still there if you build the Stripe client yourself.)

4. Routes: `export const POST = billing.webhookRoute` at `/api/stripe/webhook`, `billing.checkoutRoute` at `/api/billing/checkout`, `billing.portalRoute` at `/api/billing/portal`. The checkout form posts `offer` = a price's lookup key (or a key of `offers`, if you fix offers in code).
5. The webhook endpoint is created from **Connections**. To do it by hand instead, add `https://your-site/api/stripe/webhook` in the Stripe Dashboard with the events in `BILLING_WEBHOOK_EVENTS` (12, including `customer.subscription.trial_will_end`) and save its signing secret on Connections. Until a signing secret is set, the webhook answers 503 so Stripe retries rather than dropping events. Locally: `stripe listen --forward-to localhost:4321/api/stripe/webhook`.

How it behaves:

- Access is granted only from verified webhooks, never from the success page.
- Subscription state is re-fetched from Stripe on each event, so out-of-order delivery can't leave a stale status. `active`, `trialing` and `past_due` count (`proStatuses` to change).
- Events are processed once each (by event ID).
- **Trials:** a price's trial days apply to first-time subscribers only.
- **Coupons:** the promotion code field shows at checkout while any coupon from the admin is active (`allowPromotionCodes` to force it on or off).
- **Plan changes:** `billing.changePlan(memberId, lookupKey)` moves a subscription to another price with proration; `cancelSubscription` (at period end, or now) and `resumeSubscription` end it or undo that. The admin has buttons for all three; the Customer Portal can do the same for members.
- **Revenue:** each subscription's amount, quantity and recurring discount are stored with it, and every change of its MRR is logged (new, expansion, contraction, churn, reactivation). `revenueReport(db)` and `conversionReport(db)` power the admin's Revenue page.
- A full refund or an opened dispute on a one-time purchase removes the access it gave. Disputes and early fraud warnings flag the member (`risk_flag`).
- `billing.summary(memberId)` returns what an account page needs; `purchasable: (member) => [...]` limits which offers can be bought.

### One-time "early access" purchases

A one-time price marked "grants early access" (or an `offers` entry with `grantsEarlyAccess: true`) gives its plan with no end date and a permanent early-member badge. When you're ready to charge subscriptions, `startPaidLaunch(db, { graceDays: 14 })` gives every early member a grace period; `expireGracePeriods`, `dueNotices` and `markNoticeSent` run the rest from a scheduled job (launch email, reminder, "you're on Free now"). `earlyMemberCouponId` discounts their first subscription. `listEarlyMembers(db)` exports them.

## Lifecycle emails

Billing webhooks queue these, once each, and a scheduled job sends them:

| Email | When |
|---|---|
| Welcome | A checkout completes |
| Payment failed | An invoice payment fails (with Stripe's next retry date) |
| Trial ending | Stripe's `trial_will_end`, 3 days before |
| Cancellation scheduled | A subscription is set to cancel at period end |
| Subscription ended | A subscription ends |
| Win-back | N days after it ended (default 30), unless they're back; can offer a coupon code |
| Gift bought / received | To the buyer with the code; to the recipient on the delivery date |
| Gifted time ending | 5 days before a redeemed gift runs out, unless they've subscribed |
| Team invitation | When a team admin invites someone |

Set the From address, site URL and switches under **Members → Emails**, where every template can be edited and test-sent. With the EmDash plugin and a Cloudflare `send_email` binding named `EMAIL`, the plugin's cron sends them every 5 minutes. Without the plugin, call `processOutbox({ db, transport })` from your own scheduled job. Stripe can send receipts and card-expiry emails itself (Dashboard → Settings → Customer emails).

## Access rules

Decide what content needs in the admin (**Members → Access rules**) instead of in every page. A rule targets a collection, a taxonomy term, one entry, or a path pattern, and needs an entitlement or just a signed-in member. Exceptions open it up:

- **Free window:** free for N hours after a date field (e.g. new posts are free for 72 hours).
- **Free flag:** free whenever a boolean field is true (evergreen or lead-magnet posts).
- **Drip:** entitled members see it N days after they joined.

When access is refused the rule says what to show: a teaser (the first N blocks) with a paywall, or a redirect. The most specific rule wins (entry, term, collection, path), then priority.

```astro
---
import Paywall from "emdash-memberships/components/Paywall.astro";
import { paywallJsonLd, teaser } from "emdash-memberships";
import { members } from "../../lib/members";

const decision = await members.access(Astro, { collection: "tips", slug: entry.id, terms: ["category:prompting"], fields: entry.data });
if (!decision.allowed && decision.view === "redirect") return Astro.redirect(decision.redirectTo!);
const body = decision.allowed ? entry.data.body : teaser(entry.data.body, decision.teaserBlocks);
const jsonLd = { "@context": "https://schema.org", "@type": "Article", ...paywallJsonLd(decision, ".paywalled") };
---
<div class="paywalled"><PortableText value={body} /></div>
{!decision.allowed && <Paywall decision={decision} signedIn={!!Astro.locals.member} />}
```

Decisions are made on the server; gated content is never sent and hidden with CSS. `paywallJsonLd` marks the gated part for search engines, so a paywall isn't mistaken for cloaking.

## Components

Drop-in Astro components. They work without JavaScript, post to the routes below, and take their data from `pricingTable()` and `accountView()`. Style them with CSS variables (`--mbr-accent`, `--mbr-on-accent`, `--mbr-surface`, `--mbr-border`, `--mbr-muted`, `--mbr-radius`) or their `.mbr-*` classes.

| Component | Shows |
|---|---|
| `Paywall.astro` | The locked message for an access decision (upgrade, sign in, or "unlocks on …" for drip) |
| `PricingTable.astro` | Plans and prices from the admin, with trial, per-month, "N left" and team-seat forms |
| `MemberAccount.astro` | A whole account page: plan, renewal, billing portal, switch plan, cancel/resume, profile, teams, downloads, gifts |
| `CancelFlow.astro` | Why are you leaving, then the save offer for that reason |
| `GiftForm.astro` | Buy a gift membership, and redeem a code |
| `TeamManager.astro` | For team admins: seats, invite, join link, join domain, remove |

```astro
---
import MemberAccount from "emdash-memberships/components/MemberAccount.astro";
import { accountView } from "emdash-memberships";
const view = await accountView(env.DB, Astro.locals.member, { billing: billingEnabled() ? billing() : null });
---
<MemberAccount view={view} />
```

## Routes

Mount the ones you use (each is one line, e.g. `export const POST = members.profileRoute;`):

| Route | From | Does |
|---|---|---|
| `loginRoute`, `verifyRoute`, `logoutRoute` | `members` | Sign-in by email link |
| `profileRoute` | `members` | Saves profile answers (`onboarding=1` enforces required sign-up questions) |
| `redeemGiftRoute` | `members` | Redeems a gift code for the signed-in member |
| `joinTeamRoute`, `manageTeamRoute` | `members` | Join a team by link; team admins invite, remove, set the join domain, rotate the link |
| `downloadRoute({ bucket })` | `members` | `GET /download/[id]`: streams a protected file from R2 |
| `webhookRoute`, `checkoutRoute`, `portalRoute` | `billing` | Stripe webhook, checkout, Customer Portal |
| `changePlanRoute`, `cancelRoute`, `resumeRoute` | `billing` | Switch price; the cancel flow; undo a cancellation or end a pause |
| `giftCheckoutRoute`, `teamCheckoutRoute`, `teamSeatsRoute` | `billing` | Buy a gift; buy a team; change a team's seats |

`membershipsAstro` also takes `onboarding: true` (send new members with unanswered required questions to `paths.onboarding`), `autoJoinTeams` (default on), and `verifyHuman: turnstileFromSettings()` to check Cloudflare Turnstile on sign-in with the keys saved on **Connections** (or `turnstileVerifier(() => env.TURNSTILE_SECRET_KEY)` for an environment variable). `getMembershipSecrets()` returns the Turnstile site key for your form.

## Profile questions

Define questions in the admin (**Member settings → Profile questions**): short or long text, one or several choices, a checkbox, or a link. Each can be required and asked at sign-up. Answers are stored per member, shown on their admin page, included in the CSV export, and sent with the `member.profile_updated` event, so a newsletter can segment on them (e.g. "readers who use Claude").

## Cancel flow and pausing

`cancelRoute` asks why the member is leaving. Each reason can carry a save offer, set under **Member settings → Cancel flow**:

- `coupon CODE`: apply an active coupon to their subscription;
- `pause N`: pause billing for N months (no charges and no access until it resumes);
- `switch lookup_key`: move them to another recurring price (e.g. annual).

Every attempt is recorded with its outcome. The settings page shows why people leave and how many stayed. `billing.pauseSubscription`, `unpauseSubscription` and `applyCoupon` are available on their own too.

## Gifts

Mark a one-time price as a gift with **gift days** (e.g. $90 for 365 days of Pro). `giftCheckoutRoute` takes an optional recipient email, name, message and delivery date. Once paid:

- the buyer gets the code;
- the recipient (if given) gets it on the delivery date;
- redeeming gives that many days of the plan, stacked after any time they already have;
- a reminder goes out five days before it ends, unless they've subscribed;
- a full refund cancels the gift, or ends the time if it was redeemed.

Staff can make free codes for giveaways under **Members → Gifts**.

## Teams

Mark a recurring price **per seat** to sell team plans. `teamCheckoutRoute` buys N seats and creates a team owned by the buyer, who is its first admin. Admins invite by email or share the join link, and people with an email at the team's **join domain** are seated when they sign in. Every seat holder gets the team's plan while the subscription is live. `teamSeatsRoute` changes the seat count, prorated. Staff can make free teams in the admin, e.g. for partners.

## Downloads

Files in an R2 bucket (prompt packs, templates, PDFs), each needing an entitlement and with an optional per-member limit. Add them under **Members → Downloads** by their key in the bucket, and mount `downloadRoute({ bucket: () => env.MEDIA })` at `src/pages/download/[id].ts`. Files never get a public URL. Every download is logged and counted.

## Limited offers

Any price can be capped at a number of members ("founding 100") and/or given an end date. Checkout refuses it once it's sold out or ended. `billing.offerAvailability(lookupKey)` and `PricingTable` show how many places are left.

## Events and webhooks

Everything that changes a member's standing is an event: `member.created`, `member.plans_changed`, `member.profile_updated`, `member.deleted`, `checkout.completed`, `subscription.updated`, `subscription.cancel_scheduled`, `subscription.ended`, `payment.failed`, `gift.purchased`, `gift.redeemed`, `team.created`, `team.member_joined`, `team.member_removed`, `download.fetched`.

- `onMemberEvent((e) => …)` runs your code in the same Worker, e.g. tagging newsletter subscribers.
- Webhooks (**Member settings → Webhooks**) post events as JSON to any https URL, for Zapier, Make, n8n or your own service. Each delivery is signed with `X-Membership-Signature: t=…,v1=…` (HMAC-SHA256 of `t.body`), and failed deliveries are retried for about a day. `verifyWebhookSignature(secret, body, header)` checks it on the receiving end.
- Each member's admin page shows their event timeline, staff notes, and an audit trail of staff actions.

## Import and export

**Members → Import & export** takes a CSV with an email column. Columns are recognised by common names (name, plan, days, tier, status, complimentary, expiry, Stripe customer id, created date, and your profile question keys), so exports from most newsletter and membership tools work as they are. Run a dry run first.

- Rows marked paid get comp time on the plan you choose.
- Rows with a Stripe customer id are linked with `billing.linkCustomer`, which pulls in their existing subscription without charging them again.
- Original join dates are kept.

The same page exports every member, or only paid members, as CSV with plans, entitlements, billing state and profile answers, and can give time to a list of emails at once. In code: `importMembersCsv`, `exportMembersCsv`, `bulkGrant`.

## Members admin (EmDash plugin)

Register the plugin to get a **Members** area in the EmDash admin. Sign-in, checkout and the webhook keep running from your site's routes; the plugin is the staff side.

```js
// astro.config.mjs
import { membershipsPlugin } from "emdash-memberships/plugin";

emdash({ plugins: [membershipsPlugin({ d1Binding: "DB" })] });
```

It needs `emdash` and `zod` (both already in an EmDash site), and `stripe` for the pages that change Stripe. Pages:

- **Connections**: Stripe and Turnstile keys, entered in write-only fields and stored encrypted; test the Stripe key; create the Stripe webhook in one click.
- **Members**: totals, paid vs free, subscriptions, canceling and past-due counts, early members, comp-only access, MRR, new members per day. Also a dashboard widget.
- **All members**: search by email, filter by paid/free or early-member badge, and give any address time on a plan.
- **A member**: plans and entitlements and where they come from, subscriptions (change plan, cancel, resume), early access and grace period, a link to their Stripe customer, comp time (give or revoke), emails sent, sign out on every device, and erase. Erasing is refused while a subscription is live.
- **Plans & prices**: create plans and their entitlements, add monthly, yearly or one-time prices with trials, archive, sync to Stripe, import existing Stripe prices.
- **Coupons**: percent or amount off, once / for N months / forever, redemption limits, expiry, first purchase only.
- **Revenue**: MRR, ARR, average per subscription, a 12-month MRR chart, new / expansion / reactivation / contraction / churn, churn rates, free → paid and trial conversion.
- **Access rules**, **Teams**, **Gifts**, **Downloads**: described above.
- **Emails**: lifecycle email settings, templates, test sends and recent sends.
- **Import & export**: CSV in and out, and giving time to a list of people.
- **Early members**: everyone with the badge, with a CSV export.
- **Member settings**: profile questions, the cancel flow and its report, webhooks.

A member's page adds their timeline, staff notes (with author), the audit trail, and a form to link a Stripe customer. Every successful staff action is recorded with who did it.

MCP tools: `members_stats`, `members_plans`, `members_find`, `members_get`, `members_rules`, `members_check_access`, `members_events`, `members_grant_pro`. The same routes answer REST calls at `/_emdash/api/plugins/emdash-memberships/mcp/<name>` with an EmDash API token.

| Option | Default | |
|---|---|---|
| `d1Binding` | `"DB"` | D1 binding with the `mbr_` tables |
| `permission` | `"users:manage"` | Who can open it. Admins only by default, since it shows personal and billing data |
| `proStatuses` | active, trialing, past_due | Must match your billing config |
| `stripeSecretEnv` | `"STRIPE_SECRET_KEY"` | Env var used when no Stripe key is saved on Connections |
| `emailBinding` | `"EMAIL"` | Cloudflare `send_email` binding for lifecycle emails. `""` to send them yourself |
| `cronSchedule` | every 5 minutes | Lifecycle emails, webhooks and expiring comp time |
| `stripeDashboardUrl` | `https://dashboard.stripe.com` | Base for customer links; add `/test` in test mode |

The same queries are exported for other back offices: `memberStats`, `listMembers`, `getMemberDetail`, `signOutEverywhere`, `deleteMember`, `revenueReport`, `conversionReport`, and the catalog functions in `emdash-memberships/stripe` (`createPrice`, `createCoupon`, `importStripePrices`…).

## Comp Pro time

```ts
import { grantProTime, expireGrants } from "emdash-memberships";

await grantProTime(env.DB, { email: "reader@example.com", days: 30, key: "referral:abc:3", reason: "3 referrals" });
```

- The member is created on Free if they've never signed in, so a reward can arrive before their first visit.
- `key` is an idempotency key: a retried call never grants twice. Grants of the same plan stack end to end.
- `plan` picks the plan (default `pro`, or the first paid plan), e.g. a week of `team` for a trial.
- `revokeGrant`, `listGrants` and `compEndsAt` cover the rest. `expireGrants(db)` moves expired members back to Free unless a subscription or early access keeps them on a paid plan.

## Scheduled jobs

Comp time and grace periods end on a timer, and lifecycle emails go out from a queue. The EmDash plugin runs `expireGrants` and `processOutbox` itself every 5 minutes. Without the plugin, run them from a cron trigger. With EmDash's Cloudflare worker entry:

```ts
// src/worker.ts
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { cloudflareEmailTransport, expireGrants, processOutbox } from "emdash-memberships";

export { PluginBridge };
const emdashScheduled = createScheduledHandler();

export default {
	...handler,
	async scheduled(controller, env, ctx) {
		await emdashScheduled(controller, env, ctx);
		ctx.waitUntil(expireGrants(env.DB));
		ctx.waitUntil(processOutbox({ db: env.DB, transport: cloudflareEmailTransport(env.EMAIL) }));
	},
} satisfies ExportedHandler<Env>;
```

### Following plan changes

Every change between free and paid is logged. `pendingPlanChanges(db)` and `ackPlanChanges(db, seq)` let one consumer follow them, e.g. to tag paying readers in your newsletter tool.

## Email delivery with other providers

`transportLoginSender` takes any `EmailTransport`: an object with a `name` and `send(message) → { messageId? }`. Wrap your provider's API in a few lines:

```ts
import type { EmailTransport } from "emdash-memberships";

const resend: EmailTransport = {
	name: "resend",
	async send(msg) {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({ from: "Example <signin@example.com>", to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
		});
		if (!res.ok) throw new Error(`Resend ${res.status}`);
		return { messageId: (await res.json()).id };
	},
};
```

Throw `EmailSendError` (with `retryable`) if you want callers to tell outages from bad input. Pass `render` to `transportLoginSender` to replace the built-in sign-in email template, or `accentColor`, `siteUrl` and `replyTo` to tweak it.

## Using it without the Astro helpers

Everything the helpers do goes through the framework-free core:

```ts
import { createMemberships } from "emdash-memberships";

const m = createMemberships({ db: env.DB, sender, verifyPath: "/login/verify" });
await m.requestLoginLink({ email, origin: url.origin, next, ip });
const link = await m.peekLoginLink(token); // GET: check only
const result = await m.consumeLoginLink(token); // POST: use it, get a session token for your cookie
const session = await m.getSession(cookieValue); // each request
```

`db` is anything with D1's `prepare` / `batch` shape.

## Security notes

- Link tokens and session IDs are stored only as SHA-256 hashes.
- Post-login redirects (`next`) accept same-site paths only.
- The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, 30 days, renewed when less than half remains.
- Pages with a signed-in member are sent with `Cache-Control: private, no-store`.
- The login form answers the same way whether or not an address exists.

## Data

All tables are prefixed `mbr_` and live in your site's D1 database next to EmDash's own. The schema migrates itself on first use and records its version in `mbr_meta`.

| Table | Holds |
|---|---|
| `mbr_members`, `mbr_sessions`, `mbr_login_tokens` | Accounts, sessions, sign-in links |
| `mbr_plans`, `mbr_prices`, `mbr_coupons` | The catalog (synced to Stripe) |
| `mbr_member_access` | Each member's cached plans and entitlements |
| `mbr_billing`, `mbr_subscriptions`, `mbr_subscription_terms`, `mbr_checkouts` | Stripe customers, subscriptions with amounts and MRR, checkouts |
| `mbr_grants`, `mbr_grant_plans` | Comp time |
| `mbr_mrr_events`, `mbr_plan_changes` | Revenue movements, free ↔ paid log |
| `mbr_outbox`, `mbr_notices`, `mbr_settings` | Lifecycle emails, paid-launch notices, settings |
| `mbr_stripe_events` | Processed webhook event IDs |
| `mbr_access_rules` | Access rules |
| `mbr_profile_fields`, `mbr_profile_values` | Profile questions and answers |
| `mbr_cancellations` | Cancel-flow attempts and outcomes |
| `mbr_gifts`, `mbr_teams`, `mbr_team_members` | Gifts, teams and seats |
| `mbr_downloads`, `mbr_download_log` | Protected files and who fetched them |
| `mbr_events`, `mbr_webhooks`, `mbr_webhook_deliveries` | Event log and outbound webhooks |
| `mbr_notes`, `mbr_audit` | Staff notes and staff actions |

## Development

```bash
npm install
npm test          # node:test against real SQLite (node:sqlite), Node 22.5+
npm run typecheck
npm run build     # emits dist/
```

## Disclaimer

This software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability arising from, out of or in connection with the software or its use. You are responsible for reviewing and testing it before using it to handle accounts, personal data or payments on your site. See the [LICENSE](./LICENSE) for the full terms.

## License

[MIT](./LICENSE)
