import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSchema } from "../src/db.ts";
import type { LoginEmail } from "../src/email.ts";
import { grantProTime, listGrants, revokeGrant } from "../src/grants.ts";
import { recomputePlan } from "../src/launch.ts";
import { createMemberships } from "../src/memberships.ts";
import {
	archivePlan,
	can,
	cachedAccess,
	fallbackPaidPlan,
	getPlan,
	listPlans,
	listPrices,
	resolveAccess,
	savePlan,
	savePriceRecord,
} from "../src/plans.ts";
import { sqliteDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 12);

async function member(db: ReturnType<typeof sqliteDb>, id: string, email = `${id}@example.com`) {
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES (?, ?, 'free', ?)`).bind(id, email, T0).run();
}
async function subscribe(db: ReturnType<typeof sqliteDb>, memberId: string, priceId: string | null, lookupKey: string | null, status = "active") {
	await db
		.prepare(`INSERT INTO mbr_subscriptions (id, member_id, status, price_id, lookup_key, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(`sub_${memberId}_${lookupKey ?? priceId}`, memberId, status, priceId, lookupKey, T0)
		.run();
}

test("free and pro are built in; pro grants the pro entitlement", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	const plans = await listPlans(db);
	assert.deepEqual(plans.map((p) => [p.id, p.paid, p.entitlements]), [
		["free", false, []],
		["pro", true, ["pro"]],
	]);
	assert.equal(await fallbackPaidPlan(db), "pro");
	assert.equal(await archivePlan(db, "free"), false, "free can't be archived");
});

test("savePlan validates, and entitlement changes reach members who hold the plan", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	assert.deepEqual(await savePlan(db, { id: "Bad Id!", name: "x" }), { ok: false, reason: "invalid_id" });
	assert.deepEqual(await savePlan(db, { id: "team", name: "  " }), { ok: false, reason: "invalid_name" });
	const r = await savePlan(db, { id: "Team", name: "Team", entitlements: ["archive", " archive ", "seats", ""] });
	assert.ok(r.ok);
	assert.equal(r.plan.id, "team");
	assert.deepEqual(r.plan.entitlements, ["archive", "seats"]);
	assert.equal(r.created, true);

	await member(db, "m1");
	await grantProTime(db, { email: "m1@example.com", days: 10, key: "k1", plan: "team", now: T0 });
	assert.deepEqual((await cachedAccess(db, "m1")).entitlements, ["archive", "seats"]);

	await savePlan(db, { id: "team", name: "Team", entitlements: ["archive", "courses"] });
	assert.deepEqual((await cachedAccess(db, "m1")).entitlements, ["archive", "courses"]);

	// Free plan entitlements reach everyone, with or without a cache row
	await savePlan(db, { id: "free", name: "Free", entitlements: ["newsletter"] });
	assert.deepEqual((await cachedAccess(db, "m1")).entitlements, ["archive", "courses", "newsletter"]);
	assert.equal((await getPlan(db, "free"))?.paid, false, "free stays unpaid");
});

test("prices are validated and belong to a paid plan", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	const base = { planId: "pro", lookupKey: "pro_monthly", kind: "recurring" as const, amount: 900, currency: "USD", interval: "month" as const };
	assert.deepEqual(await savePriceRecord(db, { ...base, planId: "nope" }), { ok: false, reason: "unknown_plan" });
	assert.deepEqual(await savePriceRecord(db, { ...base, planId: "free" }), { ok: false, reason: "free_plan" });
	assert.deepEqual(await savePriceRecord(db, { ...base, lookupKey: "has space" }), { ok: false, reason: "invalid_lookup_key" });
	assert.deepEqual(await savePriceRecord(db, { ...base, amount: -1 }), { ok: false, reason: "invalid_amount" });
	assert.deepEqual(await savePriceRecord(db, { ...base, interval: null }), { ok: false, reason: "invalid_interval" });
	const ok = await savePriceRecord(db, { ...base, trialDays: 7 });
	assert.ok(ok.ok);
	assert.equal(ok.price.currency, "usd");
	assert.equal(ok.price.trialDays, 7);
	await savePlan(db, { id: "team", name: "Team" });
	assert.deepEqual(await savePriceRecord(db, { ...base, planId: "team" }), { ok: false, reason: "lookup_key_taken" });
	const once = await savePriceRecord(db, { planId: "pro", lookupKey: "early", kind: "one_time", amount: 100, currency: "usd", grantsEarlyAccess: true, trialDays: 30 });
	assert.ok(once.ok);
	assert.equal(once.price.interval, null);
	assert.equal(once.price.trialDays, 0, "one-time prices have no trial");
	assert.equal(once.price.grantsEarlyAccess, true);
	assert.equal((await listPrices(db, { planId: "pro" })).length, 2);
});

test("access comes from subscriptions, early access and grants, mapped to plans", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	await savePlan(db, { id: "team", name: "Team", entitlements: ["pro", "seats"] });
	await savePriceRecord(db, { planId: "team", lookupKey: "team_monthly", stripePriceId: "price_team", kind: "recurring", amount: 2900, currency: "usd", interval: "month" });
	await savePriceRecord(db, { planId: "pro", lookupKey: "early_access", kind: "one_time", amount: 100, currency: "usd", grantsEarlyAccess: true });

	// Subscription matched by Stripe price id
	await member(db, "a");
	await subscribe(db, "a", "price_team", null);
	assert.deepEqual(await resolveAccess(db, "a", { now: T0 }), { plans: ["team"], entitlements: ["pro", "seats"], paid: true });

	// Subscription matched by lookup key only; unknown price falls back to pro
	await member(db, "b");
	await subscribe(db, "b", "price_other", "team_monthly");
	await member(db, "c");
	await subscribe(db, "c", "price_legacy", "legacy");
	assert.deepEqual((await resolveAccess(db, "b", { now: T0 })).plans, ["team"]);
	assert.deepEqual((await resolveAccess(db, "c", { now: T0 })).plans, ["pro"]);

	// A canceled subscription grants nothing
	await member(db, "d");
	await subscribe(db, "d", "price_team", null, "canceled");
	assert.deepEqual(await resolveAccess(db, "d", { now: T0 }), { plans: [], entitlements: [], paid: false });

	// Early access grants the plan of the early-access price
	await member(db, "e");
	await db.prepare(`INSERT INTO mbr_billing (member_id, early_member, early_access_at, updated_at) VALUES ('e', 1, ?, ?)`).bind(T0, T0).run();
	assert.deepEqual((await resolveAccess(db, "e", { now: T0 })).plans, ["pro"]);

	// Several sources combine
	await grantProTime(db, { email: "e@example.com", days: 5, key: "g-e", plan: "team", now: T0 });
	assert.deepEqual(await resolveAccess(db, "e", { now: T0 }), { plans: ["pro", "team"], entitlements: ["pro", "seats"], paid: true });

	// recomputePlan stores it and keeps the 0.2 plan field
	assert.equal(await recomputePlan(db, "a", { now: T0 }), "pro");
	assert.deepEqual((await cachedAccess(db, "a")).plans, ["team"]);
});

test("grants stack per plan and default to the fallback plan", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	await savePlan(db, { id: "team", name: "Team", entitlements: ["seats"] });
	const a = await grantProTime(db, { email: "x@example.com", days: 10, key: "a", now: T0 });
	const b = await grantProTime(db, { email: "x@example.com", days: 10, key: "b", plan: "team", now: T0 });
	const c = await grantProTime(db, { email: "x@example.com", days: 10, key: "c", now: T0 });
	assert.ok(a.ok && b.ok && c.ok);
	assert.equal(a.grant.planId, "pro");
	assert.equal(b.grant.startsAt, T0, "a different plan doesn't stack behind pro");
	assert.equal(c.grant.startsAt, T0 + 10 * DAY, "same plan stacks");
	assert.deepEqual(await grantProTime(db, { email: "x@example.com", days: 1, key: "d", plan: "free" }), { ok: false, reason: "invalid_plan" });
	assert.deepEqual(await grantProTime(db, { email: "y@example.com", days: 1, key: "e", plan: "nope" }), { ok: false, reason: "invalid_plan" });
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mbr_members WHERE email = 'y@example.com'`).first<{ n: number }>())?.n, 0, "no stray member");

	// 0.2 grants (no plan row) grant the fallback plan
	await db.prepare(`DELETE FROM mbr_grant_plans WHERE grant_id = ?`).bind(a.grant.id).run();
	const grants = await listGrants(db, a.grant.memberId);
	assert.equal(grants.find((g) => g.key === "a")?.planId, null);
	await revokeGrant(db, "b", { now: T0 + 1 });
	assert.deepEqual((await resolveAccess(db, a.grant.memberId, { now: T0 + 2 })).plans, ["pro"]);
});

test("sessions carry plans and entitlements; can() checks them", async () => {
	const db = sqliteDb();
	const sent: LoginEmail[] = [];
	const m = createMemberships({ db, sender: { send: async (e) => void sent.push(e) }, now: () => T0 });
	await savePlan(db, { id: "free", name: "Free", entitlements: ["newsletter"] });
	await m.requestLoginLink({ email: "reader@example.com", origin: "https://example.com" });
	const consumed = await m.consumeLoginLink(new URL(sent[0].url).searchParams.get("token")!);
	assert.ok(consumed.ok);
	assert.deepEqual(consumed.member.entitlements, ["newsletter"], "a new member gets the free plan's entitlements");
	assert.equal(can(consumed.member, "newsletter"), true);
	assert.equal(can(consumed.member, "pro"), false);

	await grantProTime(db, { email: "reader@example.com", days: 30, key: "k", now: T0 });
	const session = await m.getSession(consumed.session.token);
	assert.equal(session?.member.plan, "pro");
	assert.deepEqual(session?.member.plans, ["pro"]);
	assert.deepEqual(session?.member.entitlements, ["newsletter", "pro"]);
	assert.equal(can(session?.member, "pro"), true);

	// A 0.2-shaped member (no entitlements loaded) still passes "pro" from its plan
	assert.equal(can({ plan: "pro" }, "pro"), true);
	assert.equal(can({ plan: "free" }, "pro"), false);
	assert.equal(can(null, "pro"), false);
});
