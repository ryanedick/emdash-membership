import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrice, updatePriceSettings } from "../src/catalog.ts";
import { ensureSchema } from "../src/db.ts";
import { deleteDownload, downloadsFor, downloadStats, fetchDownload, saveDownload } from "../src/downloads.ts";
import { listEvents } from "../src/events.ts";
import { createCompGift, getGift, listGifts, redeemGift } from "../src/gifts.ts";
import { listOutbox } from "../src/lifecycle.ts";
import { cachedAccess, getPrice, savePlan } from "../src/plans.ts";
import { createBilling } from "../src/stripe.ts";
import { autoJoinTeams, createCompTeam, getTeam, inviteToTeam, joinTeam, listSeats, listTeams, removeFromTeam, setJoinDomain } from "../src/teams.ts";
import { addSubscription, fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9, 12);

async function setup() {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	const deps = { db, stripe: f.client, now: T0 };
	await savePlan(db, { id: "pro", name: "Pro", entitlements: ["pro"] });
	await savePlan(db, { id: "team", name: "Team", entitlements: ["pro", "seats"] });
	const billing = createBilling({ db, stripe: f.client, webhookSecret: "whsec_test", now: () => T0 });
	let evt = 0;
	const send = (type: string, object: Record<string, unknown>) => billing.handleWebhook(JSON.stringify({ id: `evt_${++evt}`, type, data: { object } }), "valid");
	const member = async (id: string, email = `${id}@example.com`) => {
		await db.prepare(`INSERT INTO mbr_members (id, email, plan, created_at) VALUES (?, ?, 'free', ?)`).bind(id, email, T0).run();
		return { id, email, plan: "free" as const, createdAt: T0, lastLoginAt: null };
	};
	return { db, f, deps, billing, send, member };
}

const urls = { successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" };

test("gifts: buy, deliver, redeem once, refund", async () => {
	const s = await setup();
	const gp = await createPrice(s.deps, { planId: "pro", lookupKey: "gift_year", kind: "one_time", amount: 9000, currency: "usd", giftDays: 365 });
	assert.ok(gp.ok);
	assert.equal(gp.price.giftDays, 365);
	const buyer = await s.member("buyer");
	assert.deepEqual(await s.billing.startCheckout({ member: buyer, offer: "gift_year", ...urls }), { ok: false, reason: "unknown_offer" }, "gift prices need the gift checkout");
	assert.deepEqual(await s.billing.startGiftCheckout({ member: buyer, lookupKey: "gift_year", recipientEmail: "nope", ...urls }), { ok: false, reason: "invalid_recipient" });

	const r = await s.billing.startGiftCheckout({ member: buyer, lookupKey: "gift_year", recipientEmail: "Friend@Example.com", message: "Enjoy!", deliverAt: T0 + 2 * DAY, ...urls });
	assert.ok(r.ok);
	const session = s.f.sessions.at(-1)!;
	assert.equal(session.mode, "payment");
	const pending = await getGift(s.db, { sessionId: session.id as string });
	assert.equal(pending?.status, "pending");
	assert.equal(pending?.recipientEmail, "friend@example.com");

	await s.send("checkout.session.completed", { id: session.id, mode: "payment", payment_status: "paid", customer: session.customer, payment_intent: "pi_gift" });
	const paid = await getGift(s.db, { id: pending!.id });
	assert.equal(paid?.status, "paid");
	const out = await listOutbox(s.db);
	const buyerMail = out.find((o) => o.kind === "gift_purchased");
	const recipientMail = out.find((o) => o.kind === "gift_received");
	assert.equal(buyerMail?.to, "buyer@example.com");
	assert.equal(recipientMail?.to, "friend@example.com");
	assert.equal(recipientMail?.sendAfter, T0 + 2 * DAY, "the recipient's email waits for the delivery date");
	assert.equal((await cachedAccess(s.db, "buyer")).paid, false, "buying a gift doesn't give the buyer access");

	const friend = await s.member("friend", "friend@example.com");
	const red = await redeemGift(s.db, paid!.code.toLowerCase(), friend, { now: T0 });
	assert.ok(red.ok);
	assert.equal(red.endsAt, T0 + 365 * DAY);
	assert.deepEqual((await cachedAccess(s.db, "friend")).plans, ["pro"]);
	assert.deepEqual(await redeemGift(s.db, paid!.code, friend, { now: T0 }), { ok: false, reason: "already_redeemed" });
	assert.ok((await listOutbox(s.db)).some((o) => o.kind === "gift_ending"));
	assert.deepEqual((await listEvents(s.db, { type: "gift.redeemed" })).map((e) => e.memberId), ["friend"]);

	await s.send("charge.refunded", { id: "ch_1", payment_intent: "pi_gift", amount: 9000, amount_refunded: 9000 });
	assert.equal((await getGift(s.db, { id: pending!.id }))?.status, "refunded");
	assert.equal((await cachedAccess(s.db, "friend")).paid, false, "a refunded gift's time is revoked");

	const comp = await createCompGift(s.db, { planId: "pro", days: 30, note: "Podcast giveaway" });
	assert.equal(comp?.status, "paid");
	assert.equal((await listGifts(s.db)).length, 2);
	assert.deepEqual(await redeemGift(s.db, "NOPE-NOPE-NOPE", friend), { ok: false, reason: "not_found" });
});

test("teams: checkout, seats, invites, link and domain joins, removal, subscription end", async () => {
	const s = await setup();
	const tp = await createPrice(s.deps, { planId: "team", lookupKey: "team_seat", kind: "recurring", amount: 700, currency: "usd", interval: "month", perSeat: true });
	assert.ok(tp.ok);
	const owner = await s.member("owner", "owner@acme.com");
	assert.deepEqual(await s.billing.startTeamCheckout({ member: owner, lookupKey: "team_seat", seats: 0, teamName: "Acme", ...urls }), { ok: false, reason: "invalid_seats" });
	const r = await s.billing.startTeamCheckout({ member: owner, lookupKey: "team_seat", seats: 3, teamName: "Acme", ...urls });
	assert.ok(r.ok);
	const session = s.f.sessions.at(-1)!;
	assert.deepEqual(session.line_items, [{ price: tp.price.stripePriceId, quantity: 3 }]);

	const sub = addSubscription(s.f, { customer: session.customer as string, priceId: tp.price.stripePriceId!, quantity: 3 });
	await s.send("checkout.session.completed", { id: session.id, mode: "subscription", payment_status: "paid", customer: session.customer, subscription: sub.id });
	const team = (await listTeams(s.db))[0];
	assert.equal(team.status, "active");
	assert.equal(team.subscriptionId, sub.id);
	assert.deepEqual((await cachedAccess(s.db, "owner")).plans, ["team"]);
	assert.equal((await s.db.prepare(`SELECT mrr FROM mbr_subscription_terms`).first<{ mrr: number }>())?.mrr, 2100, "MRR counts every seat");

	assert.deepEqual(await inviteToTeam(s.db, team.id, "a@elsewhere.com", { now: T0 }), { ok: true });
	assert.deepEqual(await inviteToTeam(s.db, team.id, "a@elsewhere.com", { now: T0 }), { ok: false, reason: "already_member" });
	assert.ok((await listOutbox(s.db)).some((o) => o.kind === "team_invite" && o.to === "a@elsewhere.com"));
	const a = await s.member("a", "a@elsewhere.com");
	assert.ok((await joinTeam(s.db, team.inviteToken, a, { now: T0 })).ok);
	assert.deepEqual((await cachedAccess(s.db, "a")).plans, ["team"]);

	// One seat left: a link join takes it; the next is refused
	const b = await s.member("b", "b@elsewhere.com");
	const c = await s.member("c", "c@elsewhere.com");
	assert.ok((await joinTeam(s.db, team.inviteToken, b, { now: T0 })).ok);
	assert.deepEqual(await joinTeam(s.db, team.inviteToken, c, { now: T0 }), { ok: false, reason: "no_seats" });

	// More seats in Stripe (prorated), then a domain auto-join
	assert.ok((await s.billing.updateTeamSeats(team.id, 4)).ok);
	assert.equal((await getTeam(s.db, { id: team.id }))?.seats, 4);
	assert.equal(s.f.subs.get(sub.id)?.items.data[0].quantity, 4);
	assert.equal((await s.billing.updateTeamSeats(team.id, 2)).ok, false, "can't drop below seats in use");
	assert.equal(await setJoinDomain(s.db, team.id, "not a domain"), false);
	assert.equal(await setJoinDomain(s.db, team.id, "@Acme.com"), true);
	const d = await s.member("d", "d@acme.com");
	assert.deepEqual(await autoJoinTeams(s.db, d, { now: T0 }), [team.id]);
	assert.equal((await listSeats(s.db, team.id)).filter((x) => x.status === "active").length, 4);

	assert.equal(await removeFromTeam(s.db, team.id, "owner@acme.com"), false, "the owner keeps their seat");
	assert.ok(await removeFromTeam(s.db, team.id, "b@elsewhere.com", { now: T0 }));
	assert.equal((await cachedAccess(s.db, "b")).paid, false);
	assert.deepEqual(await autoJoinTeams(s.db, { id: "b", email: "b@elsewhere.com" }), [], "removed people don't auto-join back");

	// The subscription ends: every seat loses access
	s.f.subs.get(sub.id)!.status = "canceled";
	await s.send("customer.subscription.deleted", { id: sub.id });
	for (const id of ["owner", "a", "d"]) assert.equal((await cachedAccess(s.db, id)).paid, false, id);
});

test("comp teams need no subscription", async () => {
	const s = await setup();
	const owner = await s.member("o", "o@partner.org");
	const team = await createCompTeam(s.db, { owner, planId: "team", seats: 5, name: "Partner", joinDomain: "partner.org", now: T0 });
	assert.ok(team);
	assert.deepEqual((await cachedAccess(s.db, "o")).plans, ["team"]);
	const x = await s.member("x", "x@partner.org");
	assert.deepEqual(await autoJoinTeams(s.db, x, { now: T0 }), [team.id]);
	assert.equal(await createCompTeam(s.db, { owner, planId: "free", seats: 1, name: "x" }), null);
});

test("capped offers: member cap and end date", async () => {
	const s = await setup();
	const p = await createPrice(s.deps, { planId: "pro", lookupKey: "founding", kind: "recurring", amount: 500, currency: "usd", interval: "month" });
	assert.ok(p.ok);
	await updatePriceSettings(s.db, "founding", { maxMembers: 1, availableUntil: T0 + DAY });
	assert.deepEqual(await s.billing.offerAvailability("founding"), { available: true, remaining: 1, endsAt: T0 + DAY, reason: "ok" });
	const first = await s.member("f1");
	assert.ok((await s.billing.startCheckout({ member: first, offer: "founding", ...urls })).ok);
	const session = s.f.sessions.at(-1)!;
	const sub = addSubscription(s.f, { customer: session.customer as string, priceId: p.price.stripePriceId! });
	await s.send("checkout.session.completed", { id: session.id, mode: "subscription", payment_status: "paid", customer: session.customer, subscription: sub.id });
	const second = await s.member("f2");
	assert.deepEqual(await s.billing.startCheckout({ member: second, offer: "founding", ...urls }), { ok: false, reason: "sold_out" });
	await updatePriceSettings(s.db, "founding", { maxMembers: null });
	const late = createBilling({ db: s.db, stripe: s.f.client, webhookSecret: "", now: () => T0 + 2 * DAY });
	assert.deepEqual(await late.startCheckout({ member: second, offer: "founding", ...urls }), { ok: false, reason: "unavailable" });
	assert.equal((await getPrice(s.db, { lookupKey: "founding" }))?.maxMembers, null);
});

test("linkCustomer pulls in an existing Stripe customer's subscriptions without charging", async () => {
	const s = await setup();
	const p = await createPrice(s.deps, { planId: "pro", lookupKey: "pro_monthly", kind: "recurring", amount: 900, currency: "usd", interval: "month" });
	assert.ok(p.ok);
	await s.member("imp", "imported@example.com");
	addSubscription(s.f, { customer: "cus_legacy", priceId: p.price.stripePriceId! });
	const r = await s.billing.linkCustomer("imp", "cus_legacy");
	assert.deepEqual(r, { ok: true, subscriptions: 1 });
	assert.deepEqual((await cachedAccess(s.db, "imp")).plans, ["pro"]);
	assert.equal(s.f.sessions.length, 0, "no checkout, no charge");
	await s.member("other");
	assert.deepEqual(await s.billing.linkCustomer("other", "cus_legacy"), { ok: false, error: "That customer belongs to another member" });
});

test("downloads: entitlement, limits, logging", async () => {
	const s = await setup();
	const files = new Map([["packs/prompts.pdf", "PDF"]]);
	const bucket = {
		async get(key: string) {
			const v = files.get(key);
			return v ? { body: new Response(v).body!, size: v.length, httpMetadata: { contentType: "application/pdf" } } : null;
		},
	};
	assert.deepEqual(await saveDownload(s.db, { title: "", r2Key: "x" }), { ok: false, reason: "invalid_title" });
	assert.deepEqual(await saveDownload(s.db, { title: "x", r2Key: "../etc" }), { ok: false, reason: "invalid_key" });
	const d = await saveDownload(s.db, { title: "Prompt pack", r2Key: "/packs/prompts.pdf", entitlement: "pro", limitPerMember: 2 });
	assert.ok(d.ok);
	assert.equal(d.download.filename, "prompts.pdf");
	const missing = await saveDownload(s.db, { title: "Gone", r2Key: "packs/gone.zip" });
	assert.ok(missing.ok);

	const free = { id: "fr", plan: "free", entitlements: [] as string[] };
	const pro = { id: "pr", plan: "pro", entitlements: ["pro"] };
	assert.deepEqual((await fetchDownload(s.db, bucket, { id: d.download.id, member: null })), { ok: false, reason: "sign_in" });
	assert.deepEqual(await fetchDownload(s.db, bucket, { id: d.download.id, member: free }), { ok: false, reason: "entitlement" });
	const ok = await fetchDownload(s.db, bucket, { id: d.download.id, member: pro, now: T0 });
	assert.ok(ok.ok);
	assert.equal(ok.ok && (await new Response(ok.body).text()), "PDF");
	assert.equal(ok.ok && ok.contentType, "application/pdf");
	await fetchDownload(s.db, bucket, { id: d.download.id, member: pro, now: T0 });
	assert.deepEqual(await fetchDownload(s.db, bucket, { id: d.download.id, member: pro }), { ok: false, reason: "limit" });
	assert.deepEqual(await fetchDownload(s.db, bucket, { id: missing.download.id, member: pro }), { ok: false, reason: "missing_file" });

	const view = await downloadsFor(s.db, pro);
	assert.deepEqual(view.map((v) => [v.download.title, v.allowed, v.remaining, v.reason]), [
		["Prompt pack", false, 0, "limit"],
		["Gone", true, null, "ok"],
	]);
	assert.deepEqual((await downloadStats(s.db)).get(d.download.id), { total: 2, members: 1 });
	assert.equal((await listEvents(s.db, { type: "download.fetched" })).length, 2);
	await deleteDownload(s.db, missing.download.id);
	assert.equal((await downloadsFor(s.db, null)).length, 1);
});
