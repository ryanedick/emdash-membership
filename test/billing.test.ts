import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoupon, createPrice } from "../src/catalog.ts";
import { ensureSchema } from "../src/db.ts";
import { listOutbox, processOutbox, renderEmail, saveLifecycleSettings, DEFAULT_SETTINGS } from "../src/lifecycle.ts";
import { cachedAccess, savePlan } from "../src/plans.ts";
import { conversionReport, mrrMovement, mrrOf, revenueReport } from "../src/revenue.ts";
import { BILLING_WEBHOOK_EVENTS, createBilling } from "../src/stripe.ts";
import type { OutboundEmail } from "../src/transport.ts";
import { addSubscription, fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 12);

async function setup() {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	let t = T0;
	const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
	const deps = { db, stripe: f.client, now: T0 };
	await savePlan(db, { id: "pro", name: "Pro", entitlements: ["pro", "archive"] });
	await savePlan(db, { id: "team", name: "Team", entitlements: ["pro", "archive", "seats"] });
	const monthly = await createPrice(deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 900, currency: "usd", interval: "month", trialDays: 7 });
	const annual = await createPrice(deps, { planId: "pro", lookupKey: "pro_annual", kind: "recurring", amount: 9000, currency: "usd", interval: "year" });
	const team = await createPrice(deps, { planId: "team", lookupKey: "team_monthly", kind: "recurring", amount: 2900, currency: "usd", interval: "month" });
	const early = await createPrice(deps, { planId: "pro", lookupKey: "early_access", kind: "one_time", amount: 100, currency: "usd", grantsEarlyAccess: true });
	assert.ok(monthly.ok && annual.ok && team.ok && early.ok);
	const billing = createBilling({ db, stripe: f.client, webhookSecret: "whsec", now: clock.now });
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m1', 'reader@example.com', 'free', ?)`).bind(T0).run();
	const member = { id: "m1", email: "reader@example.com", plan: "free" as const, createdAt: T0, lastLoginAt: null };
	let evt = 0;
	const send = (type: string, object: Record<string, unknown>) =>
		billing.handleWebhook(JSON.stringify({ id: `evt_${++evt}`, type, data: { object } }), "valid");
	return {
		db,
		f,
		billing,
		clock,
		member,
		send,
		price: { monthly: monthly.price, annual: annual.price, team: team.price, early: early.price },
	};
}

async function subscribeViaCheckout(s: Awaited<ReturnType<typeof setup>>, offer: string, extra: Record<string, unknown> = {}) {
	const r = await s.billing.startCheckout({ member: s.member, offer, successUrl: "https://x.test/billing/success", cancelUrl: "https://x.test/pricing" });
	assert.ok(r.ok, JSON.stringify(r));
	const session = s.f.sessions.at(-1)!;
	const priceId = (session.line_items as { price: string }[])[0].price;
	const sub = addSubscription(s.f, { customer: session.customer as string, priceId, ...extra });
	const res = await s.send("checkout.session.completed", { id: session.id, mode: "subscription", payment_status: "paid", customer: session.customer, subscription: sub.id });
	assert.deepEqual(res, { status: 200, body: "ok" });
	return { session, sub };
}

test("checkout works from admin prices: trial for first-timers, promotion codes when coupons exist", async () => {
	const s = await setup();
	const r = await s.billing.startCheckout({ member: s.member, offer: "pro_monthly", successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" });
	assert.ok(r.ok);
	let session = s.f.sessions.at(-1)!;
	assert.equal(session.mode, "subscription");
	assert.deepEqual(session.line_items, [{ price: s.price.monthly.stripePriceId, quantity: 1 }]);
	assert.deepEqual(session.subscription_data, { trial_period_days: 7 });
	assert.equal(session.allow_promotion_codes, undefined, "no coupons yet");

	await createCoupon({ db: s.db, stripe: s.f.client, now: T0 }, { code: "SAVE10", percentOff: 10, duration: "forever" });
	await s.billing.startCheckout({ member: s.member, offer: "early_access", successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" });
	session = s.f.sessions.at(-1)!;
	assert.equal(session.mode, "payment");
	assert.equal(session.allow_promotion_codes, true);
	assert.deepEqual(session.invoice_creation, { enabled: true });

	assert.deepEqual(await s.billing.startCheckout({ member: s.member, offer: "nope", successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" }), { ok: false, reason: "unknown_offer" });
	assert.ok(BILLING_WEBHOOK_EVENTS.includes("customer.subscription.trial_will_end"));
});

test("subscribing records MRR, maps the plan, and queues a welcome email; replays are ignored", async () => {
	const s = await setup();
	const { sub } = await subscribeViaCheckout(s, "team_monthly");
	const access = await cachedAccess(s.db, "m1");
	assert.deepEqual(access.plans, ["team"]);
	assert.deepEqual(access.entitlements, ["archive", "pro", "seats"]);
	const terms = await s.db.prepare(`SELECT * FROM mbr_subscription_terms WHERE subscription_id = ?`).bind(sub.id).first<Record<string, unknown>>();
	assert.equal(terms?.plan_id, "team");
	assert.equal(terms?.mrr, 2900);
	const events = (await s.db.prepare(`SELECT kind, mrr_before, mrr_after FROM mbr_mrr_events`).all()).results.map((r) => ({ ...(r as object) }));
	assert.deepEqual(events, [{ kind: "new", mrr_before: 0, mrr_after: 2900 }]);
	const out = await listOutbox(s.db);
	assert.deepEqual(out.map((o) => [o.kind, o.to]), [["welcome", "reader@example.com"]]);

	// The same subscription event again changes nothing
	await s.send("customer.subscription.updated", { id: sub.id });
	assert.equal((await s.db.prepare(`SELECT COUNT(*) AS n FROM mbr_mrr_events`).first<{ n: number }>())?.n, 1);
});

test("plan changes, cancellation and resume go through Stripe and update access, MRR and emails", async () => {
	const s = await setup();
	const { sub } = await subscribeViaCheckout(s, "pro_monthly");
	assert.deepEqual((await cachedAccess(s.db, "m1")).plans, ["pro"]);

	assert.deepEqual(await s.billing.changePlan("m1", "pro_monthly"), { ok: false, reason: "same_price" });
	assert.deepEqual(await s.billing.changePlan("m1", "early_access"), { ok: false, reason: "not_recurring" });
	assert.deepEqual(await s.billing.changePlan("m1", "nope"), { ok: false, reason: "unknown_price" });
	const up = await s.billing.changePlan("m1", "team_monthly");
	assert.ok(up.ok);
	assert.equal(s.f.calls.find((c) => c.method === "subscriptions.update")?.args[1] && (s.f.calls.find((c) => c.method === "subscriptions.update")!.args[1] as { proration_behavior: string }).proration_behavior, "create_prorations");
	assert.deepEqual((await cachedAccess(s.db, "m1")).plans, ["team"]);

	const annual = await s.billing.changePlan("m1", "pro_annual");
	assert.ok(annual.ok);
	const kinds = (await s.db.prepare(`SELECT kind, mrr_after FROM mbr_mrr_events ORDER BY id`).all()).results.map((r) => ({ ...(r as object) }));
	assert.deepEqual(kinds, [
		{ kind: "new", mrr_after: 900 },
		{ kind: "expansion", mrr_after: 2900 },
		{ kind: "contraction", mrr_after: 750 },
	]);

	assert.ok((await s.billing.cancelSubscription("m1")).ok);
	assert.equal(s.f.subs.get(sub.id)?.cancel_at_period_end, true);
	assert.equal((await s.billing.summary("m1")).subscription?.cancelAtPeriodEnd, true);
	assert.ok((await listOutbox(s.db)).some((o) => o.kind === "cancel_scheduled"));
	assert.equal((await cachedAccess(s.db, "m1")).paid, true, "access continues until the period ends");

	assert.ok((await s.billing.resumeSubscription("m1")).ok);
	assert.equal(s.f.subs.get(sub.id)?.cancel_at_period_end, false);

	// Stripe ends it: churn, an "ended" email now and a win-back later
	s.f.subs.get(sub.id)!.status = "canceled";
	await s.send("customer.subscription.deleted", { id: sub.id });
	assert.equal((await cachedAccess(s.db, "m1")).paid, false);
	const last = { ...((await s.db.prepare(`SELECT kind, mrr_after FROM mbr_mrr_events ORDER BY id DESC LIMIT 1`).first()) as object) };
	assert.deepEqual(last, { kind: "churn", mrr_after: 0 });
	const out = await listOutbox(s.db);
	const winBack = out.find((o) => o.kind === "win_back");
	assert.ok(out.some((o) => o.kind === "subscription_ended"));
	assert.equal(winBack?.sendAfter, T0 + 30 * DAY);
	assert.deepEqual(await s.billing.cancelSubscription("m1"), { ok: false, reason: "no_subscription" });
});

test("trials, failed payments and recurring discounts", async () => {
	const s = await setup();
	const { sub } = await subscribeViaCheckout(s, "pro_monthly", { status: "trialing", trialEnd: Math.floor((T0 + 7 * DAY) / 1000) });
	assert.equal((await s.db.prepare(`SELECT mrr FROM mbr_subscription_terms`).first<{ mrr: number }>())?.mrr, 0, "trials earn nothing yet");
	assert.equal((await cachedAccess(s.db, "m1")).paid, true, "but they grant access");

	await s.send("customer.subscription.trial_will_end", s.f.subs.get(sub.id)!);
	const trial = (await listOutbox(s.db)).find((o) => o.kind === "trial_ending");
	assert.ok(trial);

	// Converts with a forever 50% coupon: MRR is halved; a "once" coupon wouldn't count
	s.f.subs.get(sub.id)!.status = "active";
	s.f.subs.get(sub.id)!.discounts = [{ id: "di_1", source: { type: "coupon", coupon: { id: "EARLY50", duration: "forever", percent_off: 50 } } }];
	await s.send("customer.subscription.updated", { id: sub.id });
	assert.equal((await s.db.prepare(`SELECT mrr FROM mbr_subscription_terms`).first<{ mrr: number }>())?.mrr, 450);

	s.f.subs.get(sub.id)!.status = "past_due";
	await s.send("invoice.payment_failed", {
		id: "in_1",
		customer: s.f.subs.get(sub.id)!.customer,
		amount_due: 450,
		currency: "usd",
		next_payment_attempt: Math.floor((T0 + 3 * DAY) / 1000),
		parent: { subscription_details: { subscription: sub.id } },
	});
	const failed = (await listOutbox(s.db)).filter((o) => o.kind === "payment_failed");
	assert.equal(failed.length, 1);
	assert.equal((await cachedAccess(s.db, "m1")).paid, true, "past due keeps access while Stripe retries");
});

test("MRR math and movements", () => {
	const base = { status: "active", amount: 900, interval: "month", intervalCount: 1, quantity: 1, discountPct: null, discountAmount: null };
	assert.equal(mrrOf(base), 900);
	assert.equal(mrrOf({ ...base, amount: 9000, interval: "year" }), 750);
	assert.equal(mrrOf({ ...base, quantity: 3 }), 2700);
	assert.equal(mrrOf({ ...base, discountPct: 50 }), 450);
	assert.equal(mrrOf({ ...base, discountAmount: 1000 }), 0);
	assert.equal(mrrOf({ ...base, interval: "month", intervalCount: 3 }), 300);
	assert.equal(mrrOf({ ...base, status: "trialing" }), 0);
	assert.equal(mrrOf({ ...base, status: "past_due" }), 900);
	assert.equal(mrrMovement(0, 900, false), "new");
	assert.equal(mrrMovement(0, 900, true), "reactivation");
	assert.equal(mrrMovement(900, 0, true), "churn");
	assert.equal(mrrMovement(900, 2900, true), "expansion");
	assert.equal(mrrMovement(900, 750, true), "contraction");
	assert.equal(mrrMovement(900, 900, true), null);
});

test("revenue and conversion reports", async () => {
	const s = await setup();
	await subscribeViaCheckout(s, "pro_monthly");
	await s.db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m2', 'two@example.com', 'free', ?)`).bind(T0).run();
	s.member.id = "m2";
	s.member.email = "two@example.com";
	const { sub: second } = await subscribeViaCheckout(s, "team_monthly");
	const r = await revenueReport(s.db, { now: T0 + 1 });
	assert.equal(r.currency, "usd");
	assert.equal(r.mrr, 3800);
	assert.equal(r.arr, 45600);
	assert.equal(r.payingSubscriptions, 2);
	assert.equal(r.arpu, 1900);
	assert.equal(r.window.new, 3800);
	assert.equal(r.history.length, 12);
	assert.equal(r.history.at(-1)?.[1], 3800);

	s.clock.advance(DAY);
	s.f.subs.get(second.id)!.status = "canceled";
	await s.send("customer.subscription.deleted", { id: second.id });
	const after = await revenueReport(s.db, { now: T0 + 2 * DAY });
	assert.equal(after.mrr, 900);
	assert.equal(after.window.churn, 2900);
	assert.equal(after.window.net, 900);

	const conv = await conversionReport(s.db, { now: T0 + 2 * DAY });
	assert.equal(conv.joined, 2);
	assert.equal(conv.convertedToPaid, 1);
});

test("the outbox sends due emails once, honours switches, and retries failures", async () => {
	const s = await setup();
	const sent: OutboundEmail[] = [];
	let fail = false;
	const transport = {
		name: "test",
		async send(m: OutboundEmail) {
			if (fail) throw new Error("provider down");
			sent.push(m);
			return {};
		},
	};
	await subscribeViaCheckout(s, "pro_monthly");

	// Not configured yet: nothing sent
	const blocked = await processOutbox({ db: s.db, transport, now: T0 });
	assert.match(blocked.error ?? "", /From address/);

	await saveLifecycleSettings(s.db, { from: { email: "hello@example.com", name: "Example" }, siteUrl: "https://example.com", siteName: "Example Tips" });
	fail = true;
	const r1 = await processOutbox({ db: s.db, transport, now: T0 });
	assert.deepEqual(r1, { sent: 0, failed: 1, skipped: 0 });
	const retry = (await listOutbox(s.db))[0];
	assert.equal(retry.attempts, 1);
	assert.equal(retry.sendAfter, T0 + 5 * 60_000);
	fail = false;
	assert.deepEqual(await processOutbox({ db: s.db, transport, now: T0 + 1000 }), { sent: 0, failed: 0, skipped: 0 }, "not due yet");
	assert.deepEqual(await processOutbox({ db: s.db, transport, now: T0 + 6 * 60_000 }), { sent: 1, failed: 0, skipped: 0 });
	assert.equal(sent[0].subject, "Welcome to Pro");
	assert.match(sent[0].text, /https:\/\/example\.com\/account/);
	assert.match(sent[0].html, /<a href="https:\/\/example\.com\/account"/);
	assert.deepEqual(sent[0].from, { email: "hello@example.com", name: "Example" });

	// A kind switched off is dropped, not sent
	await saveLifecycleSettings(s.db, { enabled: { ...DEFAULT_SETTINGS.enabled, cancel_scheduled: false } });
	await s.billing.cancelSubscription("m1");
	const r2 = await processOutbox({ db: s.db, transport, now: T0 + 7 * 60_000 });
	assert.equal(r2.skipped, 1);
	assert.equal(sent.length, 1);

	// A win-back is dropped when the member is on a paid plan again by then
	await s.billing.resumeSubscription("m1");
	const subId = (await s.billing.summary("m1")).subscription!.id;
	s.f.subs.get(subId)!.status = "canceled";
	await s.send("customer.subscription.deleted", { id: subId });
	await s.db.prepare(`UPDATE mbr_members SET plan = 'pro' WHERE id = 'm1'`).run();
	const r3 = await processOutbox({ db: s.db, transport, now: T0 + 31 * DAY });
	assert.equal(sent.at(-1)?.subject, "Your Pro access has ended");
	assert.ok(r3.skipped >= 1);
	assert.ok(!sent.some((m) => m.subject.startsWith("Come back")));
});

test("templates render placeholders and can be overridden", () => {
	const settings = { ...DEFAULT_SETTINGS, siteUrl: "https://example.com/", siteName: "Example", winBackCode: "BACK20" };
	const r = renderEmail("payment_failed", { planName: "Pro", amount: 900, currency: "usd", nextAttempt: Date.UTC(2026, 10, 12) }, settings);
	assert.equal(r.subject, "Your Example payment didn't go through");
	assert.match(r.text, /\$9\.00 for Pro/);
	assert.match(r.text, /next attempt November 12, 2026/);
	const wb = renderEmail("win_back", { planName: "Pro" }, settings);
	assert.match(wb.text, /Use code BACK20/);
	const custom = renderEmail("welcome", { planName: "Pro" }, { ...settings, templates: { welcome: { subject: "Hi from {{site_name}}", body: "<b>{{plan_name}}</b>" } } });
	assert.equal(custom.subject, "Hi from Example");
	assert.match(custom.html, /&lt;b&gt;Pro&lt;\/b&gt;/, "HTML in templates is escaped");
});
