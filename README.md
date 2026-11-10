# emdash-memberships

Member accounts for [EmDash](https://github.com/emdash-cms/emdash) sites on Cloudflare: passwordless magic-link sign-in, sessions, Stripe subscriptions and one-time purchases, and comp "Pro" time for rewards and giveaways.

- **Sign-in by email link.** No passwords. Links are single-use, expire in 15 minutes, and are rate-limited per address and per IP.
- **Free and Pro plans.** `Astro.locals.member.plan` tells every page what the visitor may see.
- **Stripe, optional.** Checkout, the Customer Portal, and a webhook handler that turns payments, refunds and disputes into access.
- **Comp time.** Give someone Pro for N days without Stripe, once per idempotency key, stacking end to end.
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

## Stripe (optional)

1. In Stripe, create Prices with **lookup keys** (e.g. `pro_monthly`, `pro_annual`). Your code refers to lookup keys, so test and live mode share it.
2. Set secrets: `wrangler secret put STRIPE_SECRET_KEY` (a restricted key is fine) and `STRIPE_WEBHOOK_SECRET`.
3. Wire it up:

   ```ts
   // src/lib/billing.ts
   import { env } from "cloudflare:workers";
   import { createBilling } from "emdash-memberships/stripe";
   import Stripe from "stripe";
   import { members } from "./members";

   const OFFERS = {
   	pro_monthly: { lookupKey: "pro_monthly", mode: "subscription" },
   	pro_annual: { lookupKey: "pro_annual", mode: "subscription" },
   } as const;

   let stripe: Stripe | undefined;

   export const billing = members.billingRoutes({
   	enabled: () => !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET,
   	billing: () => {
   		stripe ??= new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
   		return createBilling({ db: env.DB, stripe, webhookSecret: env.STRIPE_WEBHOOK_SECRET, offers: OFFERS });
   	},
   });
   ```

4. Routes: `export const POST = billing.webhookRoute` at `/api/stripe/webhook`, `billing.checkoutRoute` at `/api/billing/checkout` (form field `offer`), `billing.portalRoute` at `/api/billing/portal`.
5. In the Stripe Dashboard, add a webhook endpoint for `https://your-site/api/stripe/webhook` with the events in `BILLING_WEBHOOK_EVENTS`. Locally: `stripe listen --forward-to localhost:4321/api/stripe/webhook`.

How it behaves:

- Access is granted only from verified webhooks, never from the success page.
- Subscription state is re-fetched from Stripe on each event, so out-of-order delivery can't leave a stale status. `active`, `trialing` and `past_due` count as Pro (`proStatuses` to change).
- Events are processed once each (by event ID).
- A full refund or an opened dispute on a one-time purchase removes the access it gave. Disputes and early fraud warnings flag the member (`risk_flag`).
- `billing.summary(memberId)` returns what an account page needs; `purchasable: (member) => [...]` limits which offers can be bought.

### One-time "early access" purchases

An offer with `mode: "payment", grantsEarlyAccess: true` gives Pro with no end date and a permanent early-member badge. When you're ready to charge subscriptions, `startPaidLaunch(db, { graceDays: 14 })` gives every early member a grace period; `expireGracePeriods`, `dueNotices` and `markNoticeSent` run the rest from a scheduled job (launch email, reminder, "you're on Free now"). `earlyMemberCouponId` discounts their first subscription. `listEarlyMembers(db)` exports them.

## Comp Pro time

```ts
import { grantProTime, expireGrants } from "emdash-memberships";

await grantProTime(env.DB, { email: "reader@example.com", days: 30, key: "referral:abc:3", reason: "3 referrals" });
```

- The member is created on Free if they've never signed in, so a reward can arrive before their first visit.
- `key` is an idempotency key: a retried call never grants twice. Grants stack end to end.
- `revokeGrant`, `listGrants` and `compEndsAt` cover the rest. `expireGrants(db)` moves expired members back to Free unless a subscription or early access keeps them on Pro.

## Scheduled jobs

Comp time and grace periods end on a timer, so run the expiry helpers from a cron trigger. With EmDash's Cloudflare worker entry:

```ts
// src/worker.ts
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { expireGrants } from "emdash-memberships";

export { PluginBridge };
const emdashScheduled = createScheduledHandler();

export default {
	...handler,
	async scheduled(controller, env, ctx) {
		await emdashScheduled(controller, env, ctx);
		ctx.waitUntil(expireGrants(env.DB));
	},
} satisfies ExportedHandler<Env>;
```

### Following plan changes

Every plan change is logged. `pendingPlanChanges(db)` and `ackPlanChanges(db, seq)` let one consumer follow them, e.g. to tag paying readers in your newsletter tool.

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
