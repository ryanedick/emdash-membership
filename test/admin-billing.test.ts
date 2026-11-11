import assert from "node:assert/strict";
import { test } from "node:test";
import { listCoupons } from "../src/catalog.ts";
import { ensureSchema } from "../src/db.ts";
import { getLifecycleSettings } from "../src/lifecycle.ts";
import { cachedAccess, getPlan, getPrice, listPrices } from "../src/plans.ts";
import { handleAdmin } from "../src/plugin/admin.ts";
import { createBilling } from "../src/stripe.ts";
import type { OutboundEmail } from "../src/transport.ts";
import { addSubscription, fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 9, 12);
type Block = Record<string, unknown>;

function find(blocks: Block[], pred: (b: Block) => boolean): Block | undefined {
	for (const b of blocks) {
		if (pred(b)) return b;
		for (const nested of [b.blocks, b.elements]) {
			if (Array.isArray(nested)) {
				const hit = find(nested as Block[], pred);
				if (hit) return hit;
			}
		}
	}
}

async function setup() {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	const sent: OutboundEmail[] = [];
	const deps = { stripe: f.client, transport: { name: "t", send: async (m: OutboundEmail) => (sent.push(m), {}) }, now: T0 };
	const admin = (input: Record<string, unknown>) => handleAdmin(db, input, {}, deps);
	return { db, f, sent, admin };
}

test("every page renders, with and without Stripe", async () => {
	const { db, admin } = await setup();
	for (const page of ["/", "/members", "/plans", "/coupons", "/revenue", "/emails", "/early", "widget:members-overview"]) {
		const withStripe = await admin({ type: "page_load", page });
		assert.equal(withStripe.toast, undefined, `${page}: ${withStripe.toast?.message}`);
		const without = await handleAdmin(db, { type: "page_load", page }, {}, { now: T0 });
		assert.equal(without.toast, undefined, `${page} (no Stripe): ${without.toast?.message}`);
	}
	const plans = await handleAdmin(db, { type: "page_load", page: "/plans" }, {}, { now: T0 });
	assert.ok(find(plans.blocks, (b) => b.type === "banner" && String(b.title).includes("Stripe isn't connected")));
	const blocked = await handleAdmin(db, { type: "form_submit", action_id: "coupon:create", values: { code: "X1X" } }, {}, { now: T0 });
	assert.equal(blocked.toast?.message, "Stripe isn't connected.");
});

test("plans and prices from the admin", async () => {
	const { db, f, admin } = await setup();
	const created = await admin({ type: "form_submit", action_id: "plan:create", values: { id: "team", name: "Team", entitlements: "pro, seats" } });
	assert.equal(created.toast?.message, "Plan created");
	const team = await getPlan(db, "team");
	assert.deepEqual(team?.entitlements, ["pro", "seats"]);
	assert.ok(team?.stripeProductId && f.products.has(team.stripeProductId));
	assert.equal((await admin({ type: "form_submit", action_id: "plan:create", values: { id: "team", name: "Team" } })).toast?.message, "A plan with that ID already exists.");
	assert.equal((await admin({ type: "form_submit", action_id: "plan:create", values: { id: "Bad Id", name: "x" } })).toast?.type, "error");

	const price = await admin({ type: "form_submit", action_id: "price:create:team", values: { lookup_key: "team_monthly", billing: "month", amount: "29", currency: "usd", trial_days: 14 } });
	assert.equal(price.toast?.type, "success", price.toast?.message);
	const p = await getPrice(db, { lookupKey: "team_monthly" });
	assert.equal(p?.amount, 2900);
	assert.equal(p?.trialDays, 14);
	assert.equal(f.prices.get(p!.stripePriceId!)?.lookup_key, "team_monthly");
	assert.equal((await admin({ type: "form_submit", action_id: "price:create:team", values: { lookup_key: "x", billing: "month", amount: "abc" } })).toast?.message, "Enter an amount like 9 or 9.99.");

	const once = await admin({ type: "form_submit", action_id: "price:create:pro", values: { lookup_key: "early_access", billing: "one_time", amount: "1", currency: "usd", early: true } });
	assert.equal(once.toast?.type, "success", once.toast?.message);
	assert.equal((await getPrice(db, { lookupKey: "early_access" }))?.grantsEarlyAccess, true);

	const saved = await admin({ type: "form_submit", action_id: "plan:save:team", values: { name: "Teams", entitlements: "pro, seats, courses", sort: 20, visible: false } });
	assert.equal(saved.toast?.message, "Plan saved");
	assert.equal(f.products.get(team!.stripeProductId!)?.name, "Teams");
	assert.equal((await getPlan(db, "team"))?.visible, false);

	assert.equal((await admin({ type: "block_action", action_id: "price:archive:team", value: "team_monthly" })).toast?.message, "Price archived");
	assert.equal((await listPrices(db, { planId: "team", activeOnly: true })).length, 0);
	assert.equal((await admin({ type: "block_action", action_id: "plan:archive:team" })).toast?.message, "Plan archived");
	assert.equal(f.products.get(team!.stripeProductId!)?.active, false);

	const page = await admin({ type: "block_action", action_id: "plan:open", value: "team" });
	assert.equal((page.blocks[0] as { text: string }).text, "Teams (team)");
});

test("coupons from the admin", async () => {
	const { db, f, admin } = await setup();
	const r = await admin({ type: "form_submit", action_id: "coupon:create", values: { code: "launch25", type: "percent", value: "25", duration: "repeating", months: 3, max: 50, expires: "2026-12-31", first: true } });
	assert.equal(r.toast?.message, "Created LAUNCH25");
	const [c] = await listCoupons(db);
	assert.equal(c.percentOff, 25);
	assert.equal(c.durationMonths, 3);
	assert.equal(c.expiresAt, Date.parse("2026-12-31T23:59:59Z"));
	const flat = await admin({ type: "form_submit", action_id: "coupon:create", values: { code: "FIVE", type: "amount", value: "5.00", currency: "usd", duration: "once" } });
	assert.equal(flat.toast?.type, "success", flat.toast?.message);
	assert.equal((await admin({ type: "form_submit", action_id: "coupon:create", values: { code: "BAD", type: "percent", value: "0", duration: "once" } })).toast?.type, "error");
	assert.equal((await admin({ type: "form_submit", action_id: "coupon:create", values: { code: "BAD2", type: "percent", value: "5", duration: "once", expires: "soon" } })).toast?.message, "Use YYYY-MM-DD for the expiry date.");
	assert.equal((await admin({ type: "block_action", action_id: "coupon:off", value: c.id })).toast?.message, "Coupon deactivated");
	assert.equal(f.promos.get(c.stripePromotionCodeId!)?.active, false);
});

test("member billing actions and grants by plan", async () => {
	const { db, f, admin } = await setup();
	await admin({ type: "form_submit", action_id: "plan:create", values: { id: "team", name: "Team", entitlements: "pro, seats" } });
	await admin({ type: "form_submit", action_id: "price:create:pro", values: { lookup_key: "pro_monthly", billing: "month", amount: "9", currency: "usd" } });
	await admin({ type: "form_submit", action_id: "price:create:team", values: { lookup_key: "team_monthly", billing: "month", amount: "29", currency: "usd" } });

	// A subscriber, as the webhook would record them
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m1', 'a@example.com', 'free', ?)`).bind(T0).run();
	await db.prepare(`INSERT INTO mbr_billing (member_id, stripe_customer_id, updated_at) VALUES ('m1', 'cus_1', ?)`).bind(T0).run();
	const sub = addSubscription(f, { customer: "cus_1", priceId: (await getPrice(db, { lookupKey: "pro_monthly" }))!.stripePriceId! });
	await createBilling({ db, stripe: f.client, webhookSecret: "", now: () => T0 }).syncSubscription(sub.id);

	const page = await admin({ type: "block_action", action_id: "member:open", value: "m1" });
	assert.ok(find(page.blocks, (b) => b.type === "form" && b.block_id === "change"), "plan change form shown");
	const changed = await admin({ type: "form_submit", action_id: "sub:change:m1", values: { price: "team_monthly", prorate: true } });
	assert.equal(changed.toast?.message, "Plan changed");
	assert.deepEqual((await cachedAccess(db, "m1")).plans, ["team"]);
	assert.equal((await admin({ type: "block_action", action_id: "sub:cancel:m1" })).toast?.message, "Cancels at the end of the period");
	assert.equal((await admin({ type: "block_action", action_id: "sub:resume:m1" })).toast?.message, "Subscription resumed");
	assert.equal((await admin({ type: "block_action", action_id: "sub:cancel-now:m1" })).toast?.message, "Subscription canceled");
	assert.equal((await cachedAccess(db, "m1")).paid, false);

	const g = await admin({ type: "form_submit", action_id: "member:grant:m1", values: { plan: "team", days: 7 } });
	assert.equal(g.toast?.type, "success", g.toast?.message);
	assert.deepEqual((await cachedAccess(db, "m1")).plans, ["team"]);
	const badPlan = await admin({ type: "form_submit", action_id: "member:grant-email", values: { email: "b@example.com", plan: "free", days: 7 } });
	assert.equal(badPlan.toast?.message, "Pick a paid plan.");
});

test("email settings, templates and a test send", async () => {
	const { db, sent, admin } = await setup();
	const noSettings = await admin({ type: "block_action", action_id: "email:test:welcome" });
	assert.equal(noSettings.toast?.type, "error");

	const s = await admin({
		type: "form_submit",
		action_id: "email:settings",
		values: { from_email: "hello@example.com", from_name: "Example", site_name: "Example", site_url: "https://example.com/", winback_days: 14, winback_code: "back10", on_welcome: true, on_win_back: false },
	});
	assert.equal(s.toast?.message, "Settings saved");
	const settings = await getLifecycleSettings(db);
	assert.equal(settings.siteUrl, "https://example.com");
	assert.equal(settings.winBackCode, "BACK10");
	assert.equal(settings.enabled.win_back, false);
	assert.equal(settings.enabled.payment_failed, false, "unchecked toggles turn kinds off");

	await admin({ type: "form_submit", action_id: "email:template:welcome", values: { subject: "Hello {{plan_name}}", body: "Welcome aboard." } });
	assert.equal((await getLifecycleSettings(db)).templates.welcome?.subject, "Hello {{plan_name}}");
	const test = await admin({ type: "block_action", action_id: "email:test:welcome" });
	assert.equal(test.toast?.message, "Test sent to hello@example.com");
	assert.equal(sent[0].subject, "[Test] Hello Pro");

	await admin({ type: "form_submit", action_id: "email:template:welcome", values: { subject: "", body: "" } });
	assert.equal((await getLifecycleSettings(db)).templates.welcome, undefined, "clearing restores the default");
});
