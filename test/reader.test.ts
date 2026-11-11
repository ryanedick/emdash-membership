import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoupon, createPrice } from "../src/catalog.ts";
import { ensureSchema } from "../src/db.ts";
import { listEvents } from "../src/events.ts";
import { cachedAccess, savePlan } from "../src/plans.ts";
import { coerceProfileValue, getProfile, listProfileFields, needsOnboarding, saveProfile, saveProfileField } from "../src/profile.ts";
import { cancellationReport, cancelStep, getCancelFlow, saveCancelFlow } from "../src/retention.ts";
import { checkAccess, deleteRule, evaluateAccess, governingRule, listRules, paywallJsonLd, saveRule, teaser, type AccessRule } from "../src/rules.ts";
import { createBilling } from "../src/stripe.ts";
import { addSubscription, fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 9, 12);

const rule = (r: Partial<AccessRule>): AccessRule => ({
	id: "r",
	name: "r",
	targetType: "collection",
	target: "tips",
	requirement: "entitlement",
	entitlement: "pro",
	freeDateField: null,
	freeHours: 0,
	freeFlagField: null,
	dripDays: 0,
	lockedView: "teaser",
	teaserBlocks: 2,
	redirectTo: null,
	priority: 0,
	active: true,
	...r,
});

test("access rules: free window, free flag, entitlement, sign-in, drip", () => {
	const tips = rule({ freeDateField: "issue_date", freeHours: 72, freeFlagField: "free_override" });
	const pro = { plan: "pro", entitlements: ["pro"], createdAt: T0 - 10 * DAY };
	const free = { plan: "free", entitlements: [], createdAt: T0 };
	const fresh = { collection: "tips", slug: "a", fields: { issue_date: new Date(T0 - 10 * HOUR).toISOString() } };
	const old = { collection: "tips", slug: "b", fields: { issue_date: T0 - 5 * DAY } };

	assert.deepEqual(evaluateAccess([tips], null, { collection: "pages" }, T0).reason, "no_rule");
	const window = evaluateAccess([tips], null, fresh, T0);
	assert.equal(window.allowed, true);
	assert.equal(window.reason, "free_window");
	assert.equal(window.freeUntil, T0 - 10 * HOUR + 72 * HOUR);
	const locked = evaluateAccess([tips], free, old, T0);
	assert.equal(locked.allowed, false);
	assert.equal(locked.view, "teaser");
	assert.equal(locked.requires, "pro");
	assert.equal(locked.teaserBlocks, 2);
	assert.equal(evaluateAccess([tips], pro, old, T0).reason, "entitled");
	assert.equal(evaluateAccess([tips], null, { ...old, fields: { ...old.fields, free_override: true } }, T0).reason, "free_flag");
	assert.equal(evaluateAccess([tips], null, { collection: "tips", fields: { issue_date: T0 + DAY } }, T0).allowed, false, "a future date isn't a free window");
	// Seconds-since-epoch dates work too
	assert.equal(evaluateAccess([tips], null, { collection: "tips", fields: { issue_date: (T0 - HOUR) / 1000 } }, T0).reason, "free_window");

	const members = rule({ requirement: "signed_in", entitlement: null, lockedView: "redirect", redirectTo: "/login" });
	assert.equal(evaluateAccess([members], free, { collection: "tips" }, T0).reason, "signed_in");
	const anon = evaluateAccess([members], null, { collection: "tips" }, T0);
	assert.deepEqual([anon.allowed, anon.reason, anon.view, anon.redirectTo], [false, "sign_in_required", "redirect", "/login"]);

	const drip = rule({ dripDays: 14 });
	const d = evaluateAccess([drip], pro, { collection: "tips" }, T0);
	assert.deepEqual([d.allowed, d.reason, d.availableAt], [false, "drip", T0 + 4 * DAY]);
	assert.equal(evaluateAccess([drip], pro, { collection: "tips" }, T0 + 5 * DAY).allowed, true);

	// The 0.2 shape (plan only) still passes "pro"
	assert.equal(evaluateAccess([tips], { plan: "pro" }, old, T0).allowed, true);
});

test("the most specific rule wins, then priority", () => {
	const rules = [
		rule({ id: "col", target: "tips", entitlement: "pro" }),
		rule({ id: "term", targetType: "term", target: "category:coding", entitlement: "coding" }),
		rule({ id: "entry", targetType: "entry", target: "tips/welcome", requirement: "signed_in", entitlement: null }),
		rule({ id: "path", targetType: "path", target: "/courses/*", entitlement: "courses" }),
		rule({ id: "path2", targetType: "path", target: "/courses/*", entitlement: "courses-plus", priority: 5 }),
		rule({ id: "off", targetType: "entry", target: "tips/x", active: false }),
	];
	assert.equal(governingRule(rules, { collection: "tips", slug: "a" })?.id, "col");
	assert.equal(governingRule(rules, { collection: "tips", slug: "a", terms: ["category:coding"] })?.id, "term");
	assert.equal(governingRule(rules, { collection: "tips", slug: "welcome", terms: ["category:coding"] })?.id, "entry");
	assert.equal(governingRule(rules, { collection: "tips", id: "welcome" })?.id, "entry", "entry rules match ids too");
	assert.equal(governingRule(rules, { path: "/courses/intro/1" })?.id, "path2");
	assert.equal(governingRule(rules, { path: "/course" }), null);
	assert.equal(governingRule(rules, { collection: "tips", slug: "x" })?.id, "col", "inactive rules are ignored");
});

test("rules are saved, validated and loaded", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	assert.deepEqual(await saveRule(db, { name: "x", targetType: "term", target: "nocolon" }), { ok: false, reason: "invalid_target" });
	assert.deepEqual(await saveRule(db, { name: "x", targetType: "collection", target: "tips" }), { ok: false, reason: "entitlement_required" });
	assert.deepEqual(await saveRule(db, { name: "x", targetType: "collection", target: "tips", entitlement: "pro", lockedView: "redirect", redirectTo: "//evil.com" }), {
		ok: false,
		reason: "invalid_redirect",
	});
	const r = await saveRule(db, { name: "Tips archive", targetType: "collection", target: "tips", entitlement: "pro", freeDateField: "issue_date", freeHours: 72 });
	assert.ok(r.ok);
	const d = await checkAccess(db, null, { collection: "tips", fields: { issue_date: T0 - 100 * HOUR } }, T0);
	assert.equal(d.allowed, false);
	await saveRule(db, { ...r.rule, active: false });
	assert.equal((await checkAccess(db, null, { collection: "tips" }, T0)).reason, "no_rule", "saving clears the cache");
	await deleteRule(db, r.rule.id);
	assert.equal((await listRules(db)).length, 0);

	assert.deepEqual(teaser([1, 2, 3, 4], 2), [1, 2]);
	assert.deepEqual(teaser(null, 2), []);
	assert.deepEqual(paywallJsonLd({ allowed: true }), { isAccessibleForFree: true });
	assert.deepEqual(paywallJsonLd({ allowed: false }, ".body"), { isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".body" } });
});

test("profile fields: define, validate, save, onboarding", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	assert.deepEqual(await saveProfileField(db, { key: "Bad Key", label: "x", type: "text" }), { ok: false, reason: "invalid_key" });
	assert.deepEqual(await saveProfileField(db, { key: "tools", label: "Tools", type: "multiselect" }), { ok: false, reason: "options_required" });
	await saveProfileField(db, { key: "tools", label: "Which AI tools do you use?", type: "multiselect", options: ["ChatGPT", "Claude", "Gemini"], required: true, atSignup: true });
	await saveProfileField(db, { key: "role", label: "Role", type: "select", options: ["Engineer", "Marketer"], sortOrder: 2 });
	await saveProfileField(db, { key: "site", label: "Website", type: "url" });
	await saveProfileField(db, { key: "news", label: "Product news", type: "checkbox" });
	assert.deepEqual((await listProfileFields(db)).map((f) => f.key), ["tools", "site", "news", "role"]);

	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m', 'm@example.com', 'free', ?)`).bind(T0).run();
	assert.equal(await needsOnboarding(db, "m"), true);
	const missing = await saveProfile(db, "m", { role: "Engineer" }, { requireAll: true });
	assert.deepEqual(missing, { ok: false, missing: ["tools"] });
	const ok = await saveProfile(db, "m", { tools: ["Claude", "Bogus", "Claude"], role: "CEO", site: "javascript:alert(1)", news: "on" }, { now: T0 });
	assert.ok(ok.ok);
	assert.deepEqual(await getProfile(db, "m"), { tools: ["Claude"], news: true });
	assert.equal(await needsOnboarding(db, "m"), false);
	assert.equal((await listEvents(db, { memberId: "m" }))[0].type, "member.profile_updated");
	assert.equal(coerceProfileValue({ key: "s", label: "s", type: "url", options: [], required: false, atSignup: false, sortOrder: 0 }, "https://x.test/a"), "https://x.test/a");
	await saveProfile(db, "m", { tools: "" });
	assert.equal((await getProfile(db, "m")).tools, undefined, "an empty answer clears it");
});

async function subscriber() {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	const deps = { db, stripe: f.client, now: T0 };
	await savePlan(db, { id: "pro", name: "Pro", entitlements: ["pro"] });
	const monthly = await createPrice(deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 900, currency: "usd", interval: "month" });
	await createPrice(deps, { planId: "pro", lookupKey: "pro_annual", kind: "recurring", amount: 9000, currency: "usd", interval: "year" });
	assert.ok(monthly.ok);
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m', 'm@example.com', 'free', ?)`).bind(T0).run();
	await db.prepare(`INSERT INTO mbr_billing (member_id, stripe_customer_id, updated_at) VALUES ('m', 'cus_m', ?)`).bind(T0).run();
	const sub = addSubscription(f, { customer: "cus_m", priceId: monthly.price.stripePriceId! });
	const billing = createBilling({ db, stripe: f.client, webhookSecret: "", now: () => T0 });
	await billing.syncSubscription(sub.id);
	return { db, f, deps, billing, sub };
}

test("cancel flow: reasons, offers, outcomes, report", async () => {
	const s = await subscriber();
	await createCoupon(s.deps, { code: "STAY30", percentOff: 30, duration: "repeating", durationMonths: 3 });
	await saveCancelFlow(s.db, {
		askComment: true,
		reasons: [
			{ id: "too_expensive", label: "Too expensive", offer: { type: "coupon", code: "stay30" } },
			{ id: "break", label: "Need a break", offer: { type: "pause", months: 2 } },
			{ id: "annual", label: "Pay less often", offer: { type: "switch", lookupKey: "pro_annual" } },
			{ id: "other", label: "Other", offer: null },
		],
	});
	assert.equal((await getCancelFlow(s.db)).reasons[0].offer && (await getCancelFlow(s.db)).reasons[0].offer!.type, "coupon");

	// First step shows the offer and changes nothing
	const step1 = await cancelStep(s.db, s.billing, { memberId: "m", reason: "too_expensive", comment: "pricey", now: T0 });
	assert.ok(step1.ok && step1.outcome === "offer");
	assert.match(step1.ok && step1.outcome === "offer" ? step1.text : "", /STAY30/);
	assert.equal(s.f.subs.get(s.sub.id)?.cancel_at_period_end, false);

	// Accepting applies the coupon
	const saved = await cancelStep(s.db, s.billing, { memberId: "m", reason: "too_expensive", decision: "accept", now: T0 });
	assert.deepEqual(saved, { ok: true, outcome: "saved_coupon" });
	assert.equal((s.f.subs.get(s.sub.id)?.discounts as { coupon: string }[])[0].coupon, (await s.db.prepare(`SELECT stripe_coupon_id FROM mbr_coupons`).first<{ stripe_coupon_id: string }>())?.stripe_coupon_id);

	// Pause: billing stops and access with it
	assert.deepEqual(await cancelStep(s.db, s.billing, { memberId: "m", reason: "break", decision: "accept", now: T0 }), { ok: true, outcome: "paused" });
	assert.equal(s.f.subs.get(s.sub.id)?.pause_collection?.behavior, "void");
	assert.equal((await cachedAccess(s.db, "m")).paid, false);
	assert.ok((await s.billing.unpauseSubscription("m")).ok);
	assert.equal((await cachedAccess(s.db, "m")).paid, true);

	// Switch
	assert.deepEqual(await cancelStep(s.db, s.billing, { memberId: "m", reason: "annual", decision: "accept", now: T0 }), { ok: true, outcome: "switched" });
	assert.equal(s.f.subs.get(s.sub.id)?.items.data[0].price.lookup_key, "pro_annual");

	// No offer: cancels at period end; then nothing left to cancel
	assert.deepEqual(await cancelStep(s.db, s.billing, { memberId: "m", reason: "other", comment: "bye", now: T0 }), { ok: true, outcome: "canceled" });
	assert.equal(s.f.subs.get(s.sub.id)?.cancel_at_period_end, true);
	assert.deepEqual(await cancelStep(s.db, s.billing, { memberId: "m", reason: "other", now: T0 }), { ok: false, reason: "no_subscription" });
	assert.deepEqual(await cancelStep(s.db, s.billing, { memberId: "m", reason: "nope", now: T0 }), { ok: false, reason: "unknown_reason" });

	const report = await cancellationReport(s.db, { now: T0 });
	assert.equal(report.total, 4);
	assert.deepEqual(report.outcomes, { canceled: 1, saved_coupon: 1, paused: 1, switched: 1, kept: 0 });
	assert.equal(report.byReason.find((r) => r.reason === "too_expensive")?.saved, 1);
	assert.deepEqual(report.comments.map((c) => c.comment), ["bye"]);
});

test("an offer that can't be made right now isn't shown", async () => {
	const s = await subscriber();
	await saveCancelFlow(s.db, { askComment: false, reasons: [{ id: "x", label: "X", offer: { type: "coupon", code: "GONE" } }] });
	assert.deepEqual(await cancelStep(s.db, s.billing, { memberId: "m", reason: "x", now: T0 }), { ok: true, outcome: "canceled" });
});
