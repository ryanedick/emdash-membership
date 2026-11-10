# Changelog

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
