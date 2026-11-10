import assert from "node:assert/strict";
import { test } from "node:test";
import { compEndsAt, expireGrants, grantProTime, listGrants, revokeGrant } from "../src/grants.ts";
import { ackPlanChanges, pendingPlanChanges, recomputePlan } from "../src/launch.ts";
import { ensureSchema } from "../src/db.ts";
import { sqliteDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 12);

async function planOf(db: ReturnType<typeof sqliteDb>, email: string) {
	return (await db.prepare(`SELECT plan FROM mbr_members WHERE email = ?`).bind(email).first<{ plan: string }>())?.plan;
}

test("a grant creates the member if needed and makes them Pro until it ends", async () => {
	const db = sqliteDb();
	const r = await grantProTime(db, { email: " Reader@Example.com ", days: 30, key: "referral:s1:3", reason: "3 referrals", now: T0 });
	assert.ok(r.ok);
	assert.equal(r.created, true);
	assert.equal(r.plan, "pro");
	assert.equal(r.grant.endsAt, T0 + 30 * DAY);
	assert.equal(await planOf(db, "reader@example.com"), "pro");
	assert.equal(await compEndsAt(db, r.grant.memberId, T0), T0 + 30 * DAY);

	// Not expired yet
	assert.deepEqual(await expireGrants(db, { now: T0 + 29 * DAY }), []);
	assert.equal(await planOf(db, "reader@example.com"), "pro");

	// Expired: back to Free, and only reported once
	assert.deepEqual(await expireGrants(db, { now: T0 + 30 * DAY }), [r.grant.memberId]);
	assert.equal(await planOf(db, "reader@example.com"), "free");
	assert.deepEqual(await expireGrants(db, { now: T0 + 31 * DAY }), []);
});

test("the same key is granted once", async () => {
	const db = sqliteDb();
	const a = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 });
	const b = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 + DAY });
	assert.ok(a.ok && b.ok);
	assert.equal(b.created, false);
	assert.equal(b.grant.id, a.grant.id);
	assert.equal((await listGrants(db, a.grant.memberId)).length, 1);
});

test("grants stack end to end", async () => {
	const db = sqliteDb();
	const a = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 });
	const b = await grantProTime(db, { email: "a@example.com", days: 30, key: "k2", now: T0 + 10 * DAY });
	assert.ok(a.ok && b.ok);
	assert.equal(b.grant.startsAt, T0 + 30 * DAY);
	assert.equal(b.grant.endsAt, T0 + 60 * DAY);
	// First grant ends, second keeps them Pro
	assert.deepEqual(await expireGrants(db, { now: T0 + 31 * DAY }), []);
	assert.equal(await planOf(db, "a@example.com"), "pro");
	assert.deepEqual(await expireGrants(db, { now: T0 + 60 * DAY }), [a.grant.memberId]);
});

test("a subscription keeps the member Pro after the grant ends", async () => {
	const db = sqliteDb();
	const r = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 });
	assert.ok(r.ok);
	await db
		.prepare(`INSERT INTO mbr_subscriptions (id, member_id, status, updated_at) VALUES ('sub_1', ?, 'active', ?)`)
		.bind(r.grant.memberId, T0)
		.run();
	assert.deepEqual(await expireGrants(db, { now: T0 + 31 * DAY }), []);
	assert.equal(await planOf(db, "a@example.com"), "pro");
});

test("revoking a grant ends it now", async () => {
	const db = sqliteDb();
	const r = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 });
	assert.ok(r.ok);
	const g = await revokeGrant(db, "k1", { now: T0 + DAY });
	assert.equal(g?.revokedAt, T0 + DAY);
	assert.equal(await planOf(db, "a@example.com"), "free");
	// A revoked key is still "used": granting it again doesn't restore it.
	const again = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 + 2 * DAY });
	assert.ok(again.ok);
	assert.equal(again.created, false);
	assert.equal(again.plan, "free");
});

test("bad input is rejected", async () => {
	const db = sqliteDb();
	assert.deepEqual(await grantProTime(db, { email: "nope", days: 30, key: "k" }), { ok: false, reason: "invalid_email" });
	assert.deepEqual(await grantProTime(db, { email: "a@example.com", days: 0, key: "k" }), { ok: false, reason: "invalid_days" });
});

test("plan changes are logged once per change and can be acknowledged", async () => {
	const db = sqliteDb();
	const r = await grantProTime(db, { email: "a@example.com", days: 30, key: "k1", now: T0 });
	assert.ok(r.ok);
	// Recomputing without a change logs nothing new
	await recomputePlan(db, r.grant.memberId, { now: T0 + DAY });
	let changes = await pendingPlanChanges(db);
	assert.deepEqual(
		changes.map((c) => [c.email, c.plan]),
		[["a@example.com", "pro"]],
	);
	await ackPlanChanges(db, changes[0].seq);
	await expireGrants(db, { now: T0 + 30 * DAY });
	changes = await pendingPlanChanges(db);
	assert.deepEqual(
		changes.map((c) => [c.email, c.plan, c.changedAt]),
		[["a@example.com", "free", T0 + 30 * DAY]],
	);
});

test("upgrading backfills existing Pro members into the plan-change log", async () => {
	const db = sqliteDb();
	// Simulate a database at schema 3 with one Pro and one Free member.
	await ensureSchema(db);
	db.raw.exec(`DELETE FROM mbr_plan_changes; DROP TABLE mbr_plan_changes; DROP TABLE mbr_grants; UPDATE mbr_meta SET value = '3' WHERE key = 'schema_version'`);
	db.raw.exec(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m1', 'pro@example.com', 'pro', 1), ('m2', 'free@example.com', 'free', 1)`);
	const fresh = { prepare: db.prepare, batch: db.batch }; // new object: ensureSchema caches per db
	const changes = await pendingPlanChanges(fresh);
	assert.deepEqual(
		changes.map((c) => [c.email, c.plan]),
		[["pro@example.com", "pro"]],
	);
});
