import assert from "node:assert/strict";
import { test } from "node:test";
import { membershipsAstro, turnstileVerifier } from "../src/astro.ts";
import { createCoupon, createPrice } from "../src/catalog.ts";
import { ensureSchema } from "../src/db.ts";
import { saveDownload } from "../src/downloads.ts";
import { listAudit, listNotes, listWebhooks } from "../src/events.ts";
import { createCompGift } from "../src/gifts.ts";
import { cachedAccess, savePlan } from "../src/plans.ts";
import { getProfile, listProfileFields, saveProfileField } from "../src/profile.ts";
import { getCancelFlow, saveCancelFlow } from "../src/retention.ts";
import { listRules, saveRule } from "../src/rules.ts";
import { handleAdmin } from "../src/plugin/admin.ts";
import { createBilling } from "../src/stripe.ts";
import { createCompTeam, listSeats, listTeams } from "../src/teams.ts";
import { addSubscription, fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 9, 12);
type Block = Record<string, unknown>;

function ctx(method: string, path: string, opts: { form?: [string, string][] | Record<string, string>; member?: unknown; params?: Record<string, string> } = {}) {
	const url = new URL(path, "https://example.com");
	const body = opts.form ? new URLSearchParams(opts.form as Record<string, string>) : undefined;
	return {
		request: new Request(url, { method, body }),
		url,
		params: opts.params ?? {},
		locals: (opts.member ? { member: opts.member } : {}) as Record<string, unknown>,
		cookies: { get: () => undefined, set() {}, delete() {} },
		redirect: (to: string, status = 302) => new Response(null, { status, headers: { Location: to } }),
	} as never;
}
const loc = (r: Response) => r.headers.get("Location") ?? "";

async function setup() {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	const members = membershipsAstro({ db, sender: { send: async () => {} } });
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('m', 'm@acme.com', 'free', ?)`).bind(T0).run();
	const member = { id: "m", email: "m@acme.com", plan: "free", createdAt: T0, lastLoginAt: null };
	return { db, f, members, member };
}

test("access() applies the admin's rules to the viewer", async () => {
	const { db, members, member } = await setup();
	await saveRule(db, { name: "Tips", targetType: "collection", target: "tips", entitlement: "pro" });
	assert.equal((await members.access({ locals: {} } as never, { collection: "tips" })).allowed, false);
	await createCompGift(db, { planId: "pro", days: 1 });
	assert.equal((await members.access({ locals: { member: { ...member, entitlements: ["pro"] } } } as never, { collection: "tips" })).allowed, true);
});

test("profile route saves answers and enforces onboarding questions", async () => {
	const { db, members, member } = await setup();
	await saveProfileField(db, { key: "role", label: "Role", type: "select", options: ["Engineer", "Writer"], required: true, atSignup: true });
	await saveProfileField(db, { key: "tools", label: "Tools", type: "multiselect", options: ["Claude", "Gemini"] });
	const anon = await members.profileRoute(ctx("POST", "/api/account/profile", { form: { role: "Writer" } }));
	assert.match(loc(anon), /^\/login\?next=/);
	const missing = await members.profileRoute(ctx("POST", "/api/account/profile", { form: { onboarding: "1" }, member }));
	assert.equal(loc(missing), "/account/profile?error=missing&fields=role");
	const saved = await members.profileRoute(ctx("POST", "/api/account/profile", { form: [["role", "Writer"], ["tools", "Claude"], ["tools", "Gemini"]], member }));
	assert.equal(loc(saved), "/account?saved=profile");
	assert.deepEqual(await getProfile(db, "m"), { role: "Writer", tools: ["Claude", "Gemini"] });
});

test("gift redeem, team join and team admin routes", async () => {
	const { db, members, member } = await setup();
	const gift = await createCompGift(db, { planId: "pro", days: 30 });
	const redeemed = await members.redeemGiftRoute(ctx("POST", "/api/gift/redeem", { form: { code: gift!.code }, member }));
	assert.equal(loc(redeemed), "/account?gift=redeemed");
	assert.deepEqual((await cachedAccess(db, "m")).plans, ["pro"]);
	const again = await members.redeemGiftRoute(ctx("POST", "/api/gift/redeem", { form: { code: gift!.code }, member }));
	assert.match(loc(again), /error=already_redeemed/);

	await savePlan(db, { id: "team", name: "Team", entitlements: ["seats"] });
	await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES ('o', 'o@acme.com', 'free', ?)`).bind(T0).run();
	const team = (await createCompTeam(db, { owner: { id: "o", email: "o@acme.com" }, planId: "team", seats: 3, name: "Acme", now: T0 }))!;
	const joined = await members.joinTeamRoute(ctx("POST", "/api/team/join", { form: { token: team.inviteToken }, member }));
	assert.equal(loc(joined), "/account?team=joined");
	const notAdmin = await members.manageTeamRoute(ctx("POST", "/api/team/manage", { form: { team: team.id, action: "invite", email: "x@acme.com" }, member }));
	assert.match(loc(notAdmin), /error=not_admin/);
	const owner = { id: "o", email: "o@acme.com", plan: "pro", createdAt: T0, lastLoginAt: null };
	const invited = await members.manageTeamRoute(ctx("POST", "/api/team/manage", { form: { team: team.id, action: "invite", email: "x@acme.com" }, member: owner }));
	assert.match(loc(invited), /saved=invite/);
	assert.equal((await listSeats(db, team.id)).length, 3);
	const removed = await members.manageTeamRoute(ctx("POST", "/api/team/manage", { form: { team: team.id, action: "remove", email: "m@acme.com" }, member: owner }));
	assert.match(loc(removed), /saved=remove/);
	assert.deepEqual((await cachedAccess(db, "m")).plans, ["pro"], "the gift remains after leaving the team");
});

test("download route streams allowed files with attachment headers", async () => {
	const { db, members, member } = await setup();
	const d = await saveDownload(db, { title: "Pack", r2Key: "p.pdf", entitlement: "pro" });
	assert.ok(d.ok);
	const route = members.downloadRoute({ bucket: { get: async () => ({ body: new Response("PDF").body!, size: 3, httpMetadata: { contentType: "application/pdf" } }) } });
	const denied = await route(ctx("GET", `/download/${d.download.id}`, { member, params: { id: d.download.id } }));
	assert.equal(denied.status, 403);
	const ok = await route(ctx("GET", `/download/${d.download.id}`, { member: { ...member, entitlements: ["pro"] }, params: { id: d.download.id } }));
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("Content-Disposition"), 'attachment; filename="p.pdf"');
	assert.equal(await ok.text(), "PDF");
	const anon = await route(ctx("GET", `/download/${d.download.id}`, { params: { id: d.download.id } }));
	assert.match(loc(anon), /^\/login/);
});

test("billing routes: cancel flow with an offer, resume, change plan", async () => {
	const { db, f, member } = await setup();
	const deps = { db, stripe: f.client, now: T0 };
	const monthly = await createPrice(deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 900, currency: "usd", interval: "month" });
	await createPrice(deps, { planId: "pro", lookupKey: "pro_annual", kind: "recurring", amount: 9000, currency: "usd", interval: "year" });
	assert.ok(monthly.ok);
	await createCoupon(deps, { code: "STAY", percentOff: 20, duration: "once" });
	await saveCancelFlow(db, { askComment: true, reasons: [{ id: "price", label: "Price", offer: { type: "coupon", code: "STAY" } }, { id: "other", label: "Other", offer: null }] });
	await db.prepare(`INSERT INTO mbr_billing (member_id, stripe_customer_id, updated_at) VALUES ('m', 'cus_m', ?)`).bind(T0).run();
	const sub = addSubscription(f, { customer: "cus_m", priceId: monthly.price.stripePriceId! });
	const billing = createBilling({ db, stripe: f.client, webhookSecret: "", now: () => T0 });
	await billing.syncSubscription(sub.id);
	const members = membershipsAstro({ db, sender: { send: async () => {} } });
	const routes = members.billingRoutes({ billing: () => billing });

	const step1 = await routes.cancelRoute(ctx("POST", "/api/billing/cancel", { form: { reason: "price", comment: "pricey" }, member }));
	assert.equal(loc(step1), "/account/cancel?offer=price&comment=pricey");
	const declined = await routes.cancelRoute(ctx("POST", "/api/billing/cancel", { form: { reason: "price", decision: "decline" }, member }));
	assert.equal(loc(declined), "/account?cancel=canceled");
	assert.equal(f.subs.get(sub.id)?.cancel_at_period_end, true);
	const resumed = await routes.resumeRoute(ctx("POST", "/api/billing/resume", { member }));
	assert.equal(loc(resumed), "/account?saved=resumed");
	const switched = await routes.changePlanRoute(ctx("POST", "/api/billing/change-plan", { form: { price: "pro_annual" }, member }));
	assert.equal(loc(switched), "/account?saved=plan");
	const off = members.billingRoutes({ billing: () => billing, enabled: false });
	assert.match(loc(await off.changePlanRoute(ctx("POST", "/x", { form: { price: "pro_annual" }, member }))), /error=billing_unavailable/);
});

test("turnstileVerifier checks the token with Cloudflare, and passes through without a secret", async () => {
	const form = new FormData();
	assert.equal(await turnstileVerifier(undefined)(form, null), true);
	assert.equal(await turnstileVerifier("s")(form, null), false, "no token");
	form.set("cf-turnstile-response", "tok");
	let sent: FormData | null = null;
	const yes = turnstileVerifier("s", { fetch: (async (_u: string, init: RequestInit) => ((sent = init.body as FormData), Response.json({ success: true }))) as never });
	assert.equal(await yes(form, "1.2.3.4"), true);
	assert.equal(sent!.get("remoteip"), "1.2.3.4");
	const no = turnstileVerifier("s", { fetch: (async () => Response.json({ success: false })) as never });
	assert.equal(await no(form, null), false);
});

test("new admin pages render and their forms work; staff actions are audited", async () => {
	const { db, f } = await setup();
	const admin = (input: Record<string, unknown>) => handleAdmin(db, input, {}, { stripe: f.client, now: T0, actor: "staff@example.com" });
	for (const page of ["/access", "/teams", "/gifts", "/downloads", "/settings", "/import"]) {
		const r = await admin({ type: "page_load", page });
		assert.equal(r.toast, undefined, `${page}: ${r.toast?.message}`);
		assert.ok(r.blocks.length > 2, page);
	}
	const rule = await admin({ type: "form_submit", action_id: "rule:save", values: { name: "Tips", target_type: "collection", target: "tips", requirement: "entitlement", entitlement: "pro", free_date_field: "issue_date", free_hours: 72, locked_view: "teaser", teaser_blocks: 2, active: true } });
	assert.equal(rule.toast?.message, "Rule saved");
	assert.equal((await listRules(db))[0].freeHours, 72);
	assert.equal((await admin({ type: "form_submit", action_id: "rule:save", values: { name: "x", target_type: "term", target: "bad" } })).toast?.type, "error");

	assert.equal((await admin({ type: "form_submit", action_id: "field:save", values: { key: "role", label: "Role", type: "select", options: "Engineer, Writer", required: true } })).toast?.message, "Question saved");
	assert.deepEqual((await listProfileFields(db))[0].options, ["Engineer", "Writer"]);

	await admin({ type: "form_submit", action_id: "flow:save", values: { label_0: "Too expensive", offer_0: "pause 2", label_1: "Other", offer_1: "", comment: false } });
	const flow = await getCancelFlow(db);
	assert.deepEqual(flow.reasons.map((r) => [r.id, r.offer?.type ?? null]), [["too_expensive", "pause"], ["other", null]]);
	assert.equal(flow.askComment, false);

	assert.equal((await admin({ type: "form_submit", action_id: "hook:create", values: { url: "https://hooks.example.com/m", events: "member.created" } })).toast?.message, "Webhook added");
	assert.equal((await listWebhooks(db)).length, 1);

	await savePlan(db, { id: "team", name: "Team", entitlements: ["seats"] });
	const team = await admin({ type: "form_submit", action_id: "team:create", values: { name: "Partner", owner: "m@acme.com", plan: "team", seats: 2 } });
	assert.equal(team.toast?.message, "Team created");
	assert.equal((await listTeams(db)).length, 1);
	const gift = await admin({ type: "form_submit", action_id: "gift:create", values: { plan: "pro", days: 14, note: "Giveaway" } });
	assert.equal(gift.toast?.message, "Code created");
	assert.equal((await admin({ type: "form_submit", action_id: "download:save", values: { title: "Pack", r2_key: "p.pdf", entitlement: "pro", active: true } })).toast?.message, "Saved");

	const dry = await admin({ type: "form_submit", action_id: "import:run", values: { csv: "email,plan,days\nn@example.com,pro,5", dry: true } });
	assert.match(String((dry.blocks.find((b: Block) => b.type === "banner") as Block).title), /Dry run: 1 rows/);
	const real = await admin({ type: "form_submit", action_id: "import:run", values: { csv: "email,plan,days\nn@example.com,pro,5", dry: false } });
	assert.match(String((real.blocks.find((b: Block) => b.type === "banner") as Block).title), /1 created/);
	const exported = await admin({ type: "block_action", action_id: "export:all" });
	assert.ok(JSON.stringify(exported.blocks).includes("n@example.com"));

	const note = await admin({ type: "form_submit", action_id: "note:add:m", values: { body: "VIP" } });
	assert.equal(note.toast?.message, "Note added");
	assert.equal((await listNotes(db, "m"))[0].author, "staff@example.com");
	const memberPage = await admin({ type: "block_action", action_id: "member:open", value: "m" });
	assert.ok(JSON.stringify(memberPage.blocks).includes("Timeline"));
	const trail = await listAudit(db, { limit: 50 });
	assert.ok(trail.some((a) => a.action === "rule:save" && a.actor === "staff@example.com"));
	assert.ok(!trail.some((a) => a.action === "page_load"));
});
