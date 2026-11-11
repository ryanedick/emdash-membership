import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteMember } from "../src/admin.ts";
import { ensureSchema } from "../src/db.ts";
import {
	addNote,
	audit,
	createWebhook,
	deleteNote,
	deleteWebhook,
	emitEvent,
	listAudit,
	listDeliveries,
	listEvents,
	listNotes,
	listWebhooks,
	onMemberEvent,
	processWebhooks,
	setWebhookActive,
	signWebhook,
	verifyWebhookSignature,
} from "../src/events.ts";
import { grantProTime } from "../src/grants.ts";
import { cachedAccess, savePlan } from "../src/plans.ts";
import { getProfile, saveProfileField } from "../src/profile.ts";
import { bulkGrant, csvCell, exportMembersCsv, importMembersCsv, parseCsv } from "../src/transfer.ts";
import { sqliteDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 9, 12);

test("events are logged, heard by listeners, and emitted by core actions", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	const heard: string[] = [];
	const off = onMemberEvent((e) => void heard.push(e.type));
	const offBroken = onMemberEvent(() => {
		throw new Error("a broken listener doesn't break anything");
	});
	const quiet = console.error;
	console.error = () => {};
	await grantProTime(db, { email: "a@example.com", days: 5, key: "k", now: T0 });
	console.error = quiet;
	off();
	offBroken();
	assert.deepEqual(heard, ["member.created", "member.plans_changed"]);
	const [changed] = await listEvents(db, { type: "member.plans_changed" });
	assert.deepEqual(changed.data.before, []);
	assert.deepEqual(changed.data.after, ["pro"]);
	assert.equal((await listEvents(db, { memberId: changed.memberId! })).length, 2);

	// Erasing a member strips their event data and logs the deletion
	await deleteMember(db, changed.memberId!);
	const after = await listEvents(db, { memberId: changed.memberId! });
	assert.equal(after[0].type, "member.deleted");
	assert.ok(after.every((e) => Object.keys(e.data).length === 0));
});

test("outbound webhooks: subscribe, sign, deliver, retry", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	assert.deepEqual(await createWebhook(db, { url: "http://example.com/hook" }), { ok: false, reason: "invalid_url" });
	assert.deepEqual(await createWebhook(db, { url: "https://example.com/hook", events: ["nope"] }), { ok: false, reason: "unknown_event" });
	const all = await createWebhook(db, { url: "https://example.com/all" }, T0);
	const some = await createWebhook(db, { url: "https://example.com/plans", events: ["member.plans_changed"] }, T0);
	assert.ok(all.ok && some.ok);
	assert.match(all.webhook.secret, /^mbrsec_/);
	assert.ok((await createWebhook(db, { url: "http://localhost:8787/hook" })).ok, "http is fine for localhost");

	await emitEvent(db, "member.created", "m1", { email: "x@example.com" }, T0);
	await emitEvent(db, "member.plans_changed", "m1", { after: ["pro"] }, T0);

	const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
	let fail = true;
	const fakeFetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: init.body as string, headers: init.headers as Record<string, string> });
		return new Response("", { status: fail && url.endsWith("/all") ? 500 : 200 });
	}) as unknown as typeof fetch;

	await setWebhookActive(db, (await listWebhooks(db)).find((w) => w.url.includes("localhost"))!.id, false);
	const r1 = await processWebhooks({ db, fetch: fakeFetch, now: T0 });
	assert.deepEqual(r1, { delivered: 1, failed: 2 });
	assert.deepEqual(calls.map((c) => c.url).sort(), ["https://example.com/all", "https://example.com/all", "https://example.com/plans"]);
	const sent = calls.find((c) => c.url.endsWith("/plans"))!;
	assert.equal(sent.headers["x-membership-event"], "member.plans_changed");
	assert.equal(await verifyWebhookSignature(some.webhook.secret, sent.body, sent.headers["x-membership-signature"], { now: T0 }), true);
	assert.equal(await verifyWebhookSignature(some.webhook.secret, `${sent.body} `, sent.headers["x-membership-signature"], { now: T0 }), false);
	assert.equal(await verifyWebhookSignature(some.webhook.secret, sent.body, sent.headers["x-membership-signature"], { now: T0 + 3_600_000 }), false, "too old");
	assert.equal(JSON.parse(sent.body).type, "member.plans_changed");

	fail = false;
	assert.deepEqual(await processWebhooks({ db, fetch: fakeFetch, now: T0 + 1000 }), { delivered: 0, failed: 0 }, "retries wait");
	assert.deepEqual(await processWebhooks({ db, fetch: fakeFetch, now: T0 + 61_000 }), { delivered: 2, failed: 0 });
	const deliveries = await listDeliveries(db, all.webhook.id);
	assert.ok(deliveries.every((d) => d.deliveredAt && d.attempts === 2));
	await deleteWebhook(db, all.webhook.id);
	assert.equal((await listWebhooks(db)).length, 2);
	assert.match(await signWebhook("s", "{}", T0), /^t=\d+,v1=[0-9a-f]{64}$/);
});

test("notes and audit trail", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m', 'm@example.com', 'free', ?)`).bind(T0).run();
	await addNote(db, "m", "  Asked for a refund on the phone  ", "admin@site", T0);
	await addNote(db, "m", "   ", "admin@site", T0);
	const notes = await listNotes(db, "m");
	assert.deepEqual(notes.map((n) => n.body), ["Asked for a refund on the phone"]);
	await deleteNote(db, notes[0].id);
	assert.equal((await listNotes(db, "m")).length, 0);
	await audit(db, { actor: "admin@site", action: "grant", memberId: "m", detail: "30 days pro" }, T0);
	assert.deepEqual((await listAudit(db, { memberId: "m" })).map((a) => [a.actor, a.action]), [["admin@site", "grant"]]);
});

test("CSV: parse, quote safely, export with profiles", async () => {
	assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n\n'), [
		["a", "b"],
		["x, y", 'say "hi"'],
		["multi\nline", "z"],
	]);
	assert.equal(csvCell("=HYPERLINK()"), "'=HYPERLINK()");
	assert.equal(csvCell('a,"b"'), '"a,""b"""');
	assert.equal(csvCell(["x", "y"]), "x; y");

	const db = sqliteDb();
	await ensureSchema(db);
	await saveProfileField(db, { key: "role", label: "Role", type: "text" });
	await grantProTime(db, { email: "p@example.com", days: 5, key: "k", now: T0 });
	const csv = await exportMembersCsv(db);
	const [head, row] = parseCsv(csv);
	assert.deepEqual(head, ["email", "created_at", "last_sign_in", "paid", "plans", "entitlements", "early_member", "subscription_status", "stripe_customer_id", "role"]);
	assert.equal(row[0], "p@example.com");
	assert.equal(row[3], "true");
	assert.equal(row[4], "pro");
});

test("import recognises common export columns, grants paid time and returns customers to link", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	await savePlan(db, { id: "team", name: "Team", entitlements: ["seats"] });
	await saveProfileField(db, { key: "role", label: "Role", type: "select", options: ["Engineer", "Writer"] });
	await grantProTime(db, { email: "existing@example.com", days: 1, key: "pre", now: T0 });

	// A typical export: email, name, complimentary plan flag, Stripe customer, created date, a profile column
	const csv = [
		"Email,Name,complimentary_plan,stripe_customer_id,created_at,Role",
		"new@example.com,New,false,cus_ABC123,2025-01-02T00:00:00Z,Engineer",
		"comp@example.com,Comp,true,,2025-03-04,Writer",
		"existing@example.com,,false,,,",
		"bad-email,,,,,",
	].join("\n");
	const dry = await importMembersCsv(db, csv, { dryRun: true, paidDays: 30, now: T0 });
	assert.equal(dry.created, 0);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mbr_members`).first<{ n: number }>())?.n, 1, "dry runs write nothing");

	const r = await importMembersCsv(db, csv, { paidDays: 30, source: "old platform", now: T0 });
	assert.deepEqual([r.rows, r.created, r.existing, r.granted, r.profiles], [4, 2, 1, 1, 2]);
	assert.deepEqual(r.errors.map((e) => e.row), [5]);
	assert.deepEqual(r.toLink.map((l) => [l.email, l.customerId]), [["new@example.com", "cus_ABC123"]]);
	assert.ok(r.columns.includes("comp") && r.columns.includes("stripe") && r.columns.includes("created"));
	const comp = (await db.prepare(`SELECT id, created_at FROM mbr_members WHERE email = 'comp@example.com'`).first<{ id: string; created_at: number }>())!;
	assert.equal(comp.created_at, Date.parse("2025-03-04"), "original join date kept");
	assert.deepEqual((await cachedAccess(db, comp.id)).plans, ["pro"]);
	assert.deepEqual(await getProfile(db, comp.id), { role: "Writer" });

	// Plan and days columns; an unknown plan is an error; re-importing doesn't grant twice
	const csv2 = "email,plan,days\nt@example.com,team,14\nu@example.com,gold,5";
	const r2 = await importMembersCsv(db, csv2, { now: T0 });
	assert.equal(r2.granted, 1);
	assert.match(r2.errors[0].error, /Unknown plan/);
	assert.equal((await importMembersCsv(db, csv2, { now: T0 })).granted, 0);
	assert.deepEqual((await importMembersCsv(db, "name\nx", {})).errors, [{ row: 1, error: "No email column found" }]);

	assert.equal(await bulkGrant(db, { emails: ["t@example.com", "u@example.com"], days: 7, reason: "Launch thanks", batchKey: "launch", now: T0 }), 2);
	assert.equal(await bulkGrant(db, { emails: ["t@example.com"], days: 7, reason: "again", batchKey: "launch", now: T0 }), 0);
	assert.equal(await bulkGrant(db, { emails: ["t@example.com"], plan: "free", days: 7, reason: "x", batchKey: "b2" }), 0);
});
