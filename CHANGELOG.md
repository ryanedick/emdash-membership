# Changelog

## 0.4.0

Set up from the admin, no environment variables needed.

- **Members → Connections:** enter the Stripe secret key, the webhook signing secret and the Turnstile keys in write-only fields. EmDash stores them encrypted (plugin `settingsSchema` secret fields) and never sends them back; the page shows where each key comes from, its mode and last four characters.
- **One-click Stripe webhook:** creates the endpoint with all 12 events and saves its signing secret (replacing an older endpoint for the same address). **Test connection** checks the key and its permissions.
- `createBillingFromSettings()` builds billing from the saved keys (falling back to `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`) and returns null until a key is set. `billingRoutes({ billing })` accepts an async factory.
- `getMembershipSecrets()`, `turnstileFromSettings()` and `stripeClientFor()` for site code.
- The Stripe webhook answers 503 (so Stripe retries) while no signing secret is set, instead of rejecting the signature.
- The restricted Stripe key needs Webhook Endpoints write access for the one-click webhook.

## 0.3.0

Plans and entitlements, real billing, access rules, gifts, teams, downloads, a cancel flow, webhooks and import/export. Backward compatible: 0.2 sites keep working without changes.

- **Plans and entitlements.** Any number of plans, each granting entitlements; `can(member, "archive")` checks them. Built-in `free` and `pro` plans. Sessions load `member.plans` and `member.entitlements` (cached per member, still one query). `member.plan` stays "pro" while any paid plan is held.
- **Catalog synced to Stripe.** Plans become Products, prices become Prices with lookup keys (`createPrice`), new terms replace a Price without stranding its subscribers, existing lookup-key Prices can be imported (`importStripePrices`). Coupons become promotion codes (`createCoupon`).
- **Checkout** accepts any active price's lookup key (so `offers` is optional), applies trial days for first-time subscribers, and shows the promotion code field while a coupon is active.
- **Plan changes:** `changePlan` (with proration), `cancelSubscription` (at period end or now), `resumeSubscription`.
- **Revenue:** subscription amounts, quantities and recurring discounts are stored; MRR movements are logged. `revenueReport` (MRR, ARR, ARPU, movements, churn rates, 12-month history) and `conversionReport`.
- **Lifecycle emails:** welcome, payment failed, trial ending, cancellation scheduled, subscription ended and win-back, queued from webhooks (`mbr_outbox`) and sent by `processOutbox` with retries. Templates and switches are editable.
- **Comp time on any plan:** `grantProTime({ plan })`; grants of one plan stack.
- **Admin:** new Plans & prices, Coupons, Revenue and Emails pages; member pages show plans, entitlements and emails, and can change, cancel or resume a subscription. The plugin's cron sends lifecycle emails and expires comp time.
- New webhook event: `customer.subscription.trial_will_end` (add it to your Stripe endpoint).
- The restricted Stripe key now also needs write access to Products, Prices, Coupons and Promotion Codes for the admin's catalog pages.
- **Access rules** set in the admin (collection, term, entry or path; entitlement or signed-in; free window after a date field, free flag, drip), `members.access()`, `checkAccess`, `teaser`, `paywallJsonLd`.
- **Components:** `Paywall`, `PricingTable`, `MemberAccount`, `CancelFlow`, `GiftForm`, `TeamManager` (Astro, no JavaScript needed), with `pricingTable()` and `accountView()` view helpers.
- **New routes:** profile, gift redeem, team join and manage, downloads, change plan, cancel flow, resume, gift checkout, team checkout, team seats. `turnstileVerifier` for sign-in, optional onboarding redirect, team auto-join by email domain.
- **Profile questions** (text, choices, checkbox, link; required; asked at sign-up), included in exports and events.
- **Cancel flow** with per-reason save offers (coupon, pause, switch) and a report; `pauseSubscription`, `unpauseSubscription`, `applyCoupon`. Paused subscriptions earn no MRR and give no access.
- **Gifts:** gift prices, scheduled delivery, one-time codes, reminders, refunds; free codes from the admin.
- **Teams:** per-seat prices, invites, join links, join domains, seat changes with proration, free teams.
- **Downloads:** protected R2 files per entitlement with per-member limits and a log.
- **Limited offers:** cap a price at N members and/or an end date; `offerAvailability`.
- **Events and webhooks:** an event log for every change, `onMemberEvent` listeners, signed outbound webhooks with retries, `verifyWebhookSignature`.
- **Import/export:** CSV import that recognises common export columns, `linkCustomer` to adopt existing Stripe subscriptions without charging, CSV export, bulk grants.
- **Admin:** Access rules, Teams, Gifts, Downloads, Import & export and Member settings pages; member timeline, notes and audit trail; every staff action audited. New MCP tools: `members_rules`, `members_check_access`, `members_events`.

## 0.2.0

- New EmDash plugin, `emdash-memberships/plugin`: a Members area in the EmDash admin (overview with MRR, member search, member detail with comp time, sign out everywhere and erase, early members with CSV export), a dashboard widget and MCP tools. Admins only by default.
- New queries for staff tools: `memberStats`, `listMembers`, `getMemberDetail`, `signOutEverywhere`, `deleteMember`.
- `emdash` and `zod` are optional peer dependencies, needed only for the plugin.

## 0.1.0

First public release.

- Magic-link sign-in, sessions, Free/Pro plans on Cloudflare D1.
- `emdash-memberships/astro`: session middleware and ready-made login, verify, logout, Stripe webhook, checkout and portal routes.
- `emdash-memberships/stripe`: Checkout, Customer Portal, webhook handling, early-access purchases and the paid-launch lifecycle.
- Comp Pro time (`grantProTime`) and a plan-change log.
- Cloudflare Email Service transport and a provider-neutral `EmailTransport` interface.
