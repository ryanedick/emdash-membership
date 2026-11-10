import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteMember, getMemberDetail, listMembers, memberStats, signOutEverywhere } from "../src/admin.ts";
import { ensureSchema } from "../src/db.ts";
import { grantProTime } from "../src/grants.ts";
import { pendingPlanChanges } from "../src/launch.ts";
import { handleAdmin } from "../src/plugin/admin.ts";
import { sqliteDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 12);
type Block = Record<string, unknown>;

/** Members: free reader, early member, subscriber (monthly), subscriber (annual, canceling), past-due subscriber. */
async function seed() {
	const db = sqliteDb();
	await ensureSchema(db);
	const add = (id: string, email: string, plan: string, created: number, login: number | null = null) =>
		db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)`).bind(id, email, plan, created, login).run();
	await add("m_free", "free@example.com", "free", T0 - 40 * DAY);
	await add("m_early", "early@example.com", "pro", T0 - 5 * DAY, T0 - DAY);
	await add("m_month", "month@example.com", "pro", T0 - 3 * DAY, T0);
	await add("m_year", "year@example.com", "pro", T0 - 2 * DAY);
	await add("m_due", "due@example.com", "pro", T0 - 60 * DAY);
	await db
		.prepare(`INSERT INTO mbr_billing (member_id, stripe_customer_id, early_member, early_access_at, updated_at) VALUES ('m_early', 'cus_E', 1, ?, ?)`)
		.bind(T0 - 5 * DAY, T0)
		.run();
	const sub = (id: string, member: string, status: string, key: string, cancel = 0) =>
		db
			.prepare(`INSERT INTO mbr_subscriptions (id, member_id, status, lookup_key, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.bind(id, member, status, key, T0 + 20 * DAY, cancel, T0)
			.run();
	await sub("sub_m", "m_month", "active", "pro_monthly");
	await sub("sub_y", "m_year", "active", "pro_annual", 1);
	await sub("sub_d", "m_due", "past_due", "pro_monthly");
	await db.prepare(`INSERT INTO mbr_sessions (token_hash, member_id, created_at, expires_at, last_seen_at) VALUES ('h1', 'm_month', ?, ?, ?)`).bind(T0, T0 + DAY, T0).run();
	await db.prepare(`INSERT INTO mbr_sessions (token_hash, member_id, created_at, expires_at, last_seen_at) VALUES ('h2', 'm_month', ?, ?, ?)`).bind(T0, T0 + DAY, T0).run();
	return db;
}

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

test("memberStats counts plans, subscriptions, early members and MRR", async () => {
	const db = await seed();
	await grantProTime(db, { email: "comp@example.com", days: 10, key: "k1", now: T0 });
	const s = await memberStats(db, {
		now: T0,
		planValues: { pro_monthly: { amount: 900, interval: "month" }, pro_annual: { amount: 9000, interval: "year" } },
	});
	assert.equal(s.total, 6);
	assert.equal(s.pro, 5);
	assert.equal(s.free, 1);
	assert.equal(s.subscriptions, 3); // past_due still counts as Pro
	assert.equal(s.pastDue, 1);
	assert.equal(s.canceling, 1);
	assert.equal(s.earlyMembers, 1);
	assert.equal(s.compOnly, 1);
	assert.equal(s.new30d, 4);
	assert.equal(s.active30d, 2);
	assert.deepEqual(s.byLookupKey, { pro_annual: 1, pro_monthly: 2 });
	assert.equal(s.mrr, 900 * 2 + 750);
	assert.equal(s.growth.length, 31);
	assert.equal(s.growth.reduce((a, [, n]) => a + n, 0), 4);
	assert.equal((await memberStats(db, { now: T0 })).mrr, null);
});

test("listMembers searches, filters and pages", async () => {
	const db = await seed();
	assert.equal((await listMembers(db)).total, 5);
	assert.deepEqual((await listMembers(db, { search: "MONTH" })).items.map((m) => m.email), ["month@example.com"]);
	assert.equal((await listMembers(db, { plan: "free" })).total, 1);
	const early = await listMembers(db, { earlyOnly: true });
	assert.deepEqual(early.items.map((m) => [m.email, m.earlyMember]), [["early@example.com", true]]);
	assert.equal((await listMembers(db, { search: "%" })).total, 0, "LIKE wildcards are escaped");
	const page = await listMembers(db, { limit: 2, offset: 2 });
	assert.equal(page.items.length, 2);
	assert.equal(page.total, 5);
	assert.equal((await listMembers(db, { search: "month" })).items[0].subscriptionStatus, "active");
});

test("member detail, sign out everywhere, and delete", async () => {
	const db = await seed();
	const d = await getMemberDetail(db, "m_month", T0);
	assert.ok(d);
	assert.equal(d.activeSessions, 2);
	assert.equal(d.subscriptions[0].lookupKey, "pro_monthly");
	assert.equal(await getMemberDetail(db, "nope"), null);

	assert.equal(await signOutEverywhere(db, "m_month"), 2);
	assert.equal((await getMemberDetail(db, "m_month", T0))?.activeSessions, 0);

	assert.deepEqual(await deleteMember(db, "m_month"), { ok: false, reason: "has_subscription" });
	assert.deepEqual(await deleteMember(db, "nope"), { ok: false, reason: "not_found" });

	// A Pro member without a live subscription (early access) can be erased, leaving a final "free" change
	const before = (await pendingPlanChanges(db)).length;
	assert.deepEqual(await deleteMember(db, "m_early"), { ok: true, email: "early@example.com" });
	assert.equal(await getMemberDetail(db, "m_early"), null);
	assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM mbr_billing WHERE member_id = 'm_early'`).first<{ n: number }>().then((r) => r?.n), 0);
	const changes = await pendingPlanChanges(db);
	assert.equal(changes.length, before + 1);
	assert.deepEqual(changes.filter((c) => c.memberId === "m_early").map((c) => c.plan), ["free"]);
});

test("every admin page renders without errors", async () => {
	const db = await seed();
	for (const page of ["/", "/members", "/members?plan=pro", "/early", "widget:members-overview", "members-overview"]) {
		const r = await handleAdmin(db, { type: "page_load", page }, {}, T0);
		assert.ok(r.blocks.length > 0, page);
		assert.equal(r.toast, undefined, `${page}: ${r.toast?.message}`);
	}
	const withMrr = await handleAdmin(db, { type: "page_load", page: "/" }, { planValues: { pro_monthly: { amount: 900, interval: "month" } } }, T0);
	const stats = find(withMrr.blocks, (b) => b.type === "stats") as { items: { label: string; value: string }[] };
	assert.equal(stats.items.find((x) => x.label.startsWith("MRR"))?.value, "$18.00");
});

test("admin: search, open, grant and revoke Pro time, sign out, delete", async () => {
	const db = await seed();
	const searched = await handleAdmin(db, { type: "form_submit", action_id: "members:search", values: { search: "free", plan: "", early: false } }, {}, T0);
	const table = find(searched.blocks, (b) => b.type === "table") as { rows: { email: string }[] };
	assert.deepEqual(table.rows.map((r) => r.email), ["free@example.com"]);

	const opened = await handleAdmin(db, { type: "block_action", action_id: "member:open", value: "m_free" }, {}, T0);
	assert.equal((opened.blocks[0] as { text: string }).text, "free@example.com");

	const granted = await handleAdmin(db, { type: "form_submit", action_id: "member:grant:m_free", values: { days: 7, reason: "Support credit" } }, {}, T0);
	assert.equal(granted.toast?.type, "success", granted.toast?.message);
	assert.equal((await getMemberDetail(db, "m_free", T0))?.member.plan, "pro");
	const g = (await getMemberDetail(db, "m_free", T0))!.grants[0];
	assert.equal(g.reason, "Support credit");
	assert.equal(g.endsAt, T0 + 7 * DAY);

	const revoked = await handleAdmin(db, { type: "block_action", action_id: "grant:revoke:m_free", value: g.key }, {}, T0 + 1000);
	assert.equal(revoked.toast?.type, "success");
	assert.equal((await getMemberDetail(db, "m_free", T0 + 2000))?.member.plan, "free");

	const bad = await handleAdmin(db, { type: "form_submit", action_id: "member:grant:m_free", values: { days: 0 } }, {}, T0);
	assert.equal(bad.toast?.type, "error");

	// Grant by email to someone who has never signed in
	const byEmail = await handleAdmin(db, { type: "form_submit", action_id: "member:grant-email", values: { email: "new@example.com", days: 30 } }, {}, T0);
	assert.equal(byEmail.toast?.type, "success", byEmail.toast?.message);
	assert.equal((await listMembers(db, { search: "new@" })).items[0].plan, "pro");
	const badEmail = await handleAdmin(db, { type: "form_submit", action_id: "member:grant-email", values: { email: "nope", days: 30 } }, {}, T0);
	assert.equal(badEmail.toast?.type, "error");

	const out = await handleAdmin(db, { type: "block_action", action_id: "member:signout:m_month" }, {}, T0);
	assert.equal(out.toast?.message, "Ended 2 sessions");

	const blocked = await handleAdmin(db, { type: "block_action", action_id: "member:delete:m_month" }, {}, T0);
	assert.equal(blocked.toast?.type, "error");
	const erased = await handleAdmin(db, { type: "block_action", action_id: "member:delete:m_free" }, {}, T0);
	assert.equal(erased.toast?.message, "Erased free@example.com");
});

test("admin: paging and early-member CSV export", async () => {
	const db = await seed();
	for (let i = 0; i < 55; i++) await grantProTime(db, { email: `bulk${i}@example.com`, days: 1, key: `b${i}`, now: T0 });
	const first = await handleAdmin(db, { type: "page_load", page: "/members" }, {}, T0);
	const t1 = find(first.blocks, (b) => b.type === "table") as { rows: unknown[]; next_cursor?: string };
	assert.equal(t1.rows.length, 50);
	assert.ok(t1.next_cursor);
	const second = await handleAdmin(db, { type: "block_action", action_id: "members:page", value: { cursor: t1.next_cursor } }, {}, T0);
	const t2 = find(second.blocks, (b) => b.type === "table") as { rows: unknown[]; next_cursor?: string };
	assert.equal(t2.rows.length, 10);
	assert.equal(t2.next_cursor, undefined);

	const exported = await handleAdmin(db, { type: "block_action", action_id: "early:export" }, {}, T0);
	const code = find(exported.blocks, (b) => b.type === "code") as { code: string };
	assert.equal(code.code.split("\n")[0], "email,early_member_since,plan,subscribed,refunded");
	assert.match(code.code, /^early@example\.com,2026-11-04T12:00:00\.000Z,pro,false,false$/m);
});
