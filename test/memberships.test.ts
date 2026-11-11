import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoginEmail } from "../src/email.ts";
import { createMemberships, normalizeEmail, safeNextPath } from "../src/memberships.ts";
import { sqliteDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;

function setup(start = Date.UTC(2026, 10, 9, 12)) {
	const db = sqliteDb();
	const sent: LoginEmail[] = [];
	let t = start;
	const m = createMemberships({
		db,
		sender: { send: async (e) => void sent.push(e) },
		verifyPath: "/login/verify",
		now: () => t,
	});
	const tokenOf = (e: LoginEmail) => new URL(e.url).searchParams.get("token")!;
	return { db, m, sent, tokenOf, advance: (ms: number) => void (t += ms) };
}

test("sign-in: request, peek, consume once, then the session resolves", async () => {
	const { m, sent, tokenOf } = setup();
	assert.deepEqual(
		await m.requestLoginLink({ email: " Reader@Example.com ", origin: "https://example.com", next: "/tips/1" }),
		{ ok: true },
	);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].to, "reader@example.com");
	assert.ok(sent[0].url.startsWith("https://example.com/login/verify?token="));
	const token = tokenOf(sent[0]);

	// Peeking doesn't use it up
	assert.deepEqual(await m.peekLoginLink(token), { email: "reader@example.com" });
	assert.deepEqual(await m.peekLoginLink(token), { email: "reader@example.com" });

	const r = await m.consumeLoginLink(token, { userAgent: "test" });
	assert.ok(r.ok);
	assert.equal(r.member.email, "reader@example.com");
	assert.equal(r.member.plan, "free");
	assert.equal(r.next, "/tips/1");

	// Single use
	assert.deepEqual(await m.consumeLoginLink(token), { ok: false, reason: "invalid_or_expired" });
	assert.equal(await m.peekLoginLink(token), null);

	const s = await m.getSession(r.session.token);
	assert.equal(s?.member.id, r.member.id);
	assert.equal(s?.renewed, false);

	// Signing in again reuses the member
	await m.requestLoginLink({ email: "reader@example.com", origin: "https://example.com" });
	const r2 = await m.consumeLoginLink(tokenOf(sent[1]));
	assert.ok(r2.ok);
	assert.equal(r2.member.id, r.member.id);
	assert.equal(r2.next, null);
});

test("links expire and sessions renew past half-life, then expire", async () => {
	const { m, sent, tokenOf, advance } = setup();
	await m.requestLoginLink({ email: "a@example.com", origin: "https://example.com" });
	advance(16 * 60 * 1000);
	assert.deepEqual(await m.consumeLoginLink(tokenOf(sent[0])), { ok: false, reason: "invalid_or_expired" });

	await m.requestLoginLink({ email: "a@example.com", origin: "https://example.com" });
	const r = await m.consumeLoginLink(tokenOf(sent[1]));
	assert.ok(r.ok);
	advance(16 * DAY);
	const renewed = await m.getSession(r.session.token);
	assert.equal(renewed?.renewed, true);
	advance(31 * DAY);
	assert.equal(await m.getSession(r.session.token), null);
});

test("rate limits per address and per IP", async () => {
	const { m } = setup();
	for (let i = 0; i < 5; i++) {
		assert.deepEqual(await m.requestLoginLink({ email: "a@example.com", origin: "https://example.com" }), { ok: true });
	}
	assert.deepEqual(await m.requestLoginLink({ email: "a@example.com", origin: "https://example.com" }), {
		ok: false,
		reason: "rate_limited",
	});
	for (let i = 0; i < 20; i++) {
		await m.requestLoginLink({ email: `u${i}@example.com`, origin: "https://example.com", ip: "203.0.113.9" });
	}
	assert.deepEqual(await m.requestLoginLink({ email: "new@example.com", origin: "https://example.com", ip: "203.0.113.9" }), {
		ok: false,
		reason: "rate_limited",
	});
});

test("send failures are reported, invalid addresses rejected", async () => {
	const db = sqliteDb();
	const m = createMemberships({ db, sender: { send: async () => Promise.reject(new Error("down")) } });
	const errors = console.error;
	console.error = () => {};
	try {
		assert.deepEqual(await m.requestLoginLink({ email: "a@example.com", origin: "https://example.com" }), {
			ok: false,
			reason: "send_failed",
		});
	} finally {
		console.error = errors;
	}
	assert.deepEqual(await m.requestLoginLink({ email: "not-an-email", origin: "https://example.com" }), {
		ok: false,
		reason: "invalid_email",
	});
});

test("sign-out revokes one session or all of them", async () => {
	const { m, sent, tokenOf } = setup();
	const tokens: string[] = [];
	for (let i = 0; i < 2; i++) {
		await m.requestLoginLink({ email: "a@example.com", origin: "https://example.com" });
		const r = await m.consumeLoginLink(tokenOf(sent[i]));
		assert.ok(r.ok);
		tokens.push(r.session.token);
	}
	await m.revokeSession(tokens[0]);
	assert.equal(await m.getSession(tokens[0]), null);
	const s = await m.getSession(tokens[1]);
	assert.ok(s);
	await m.revokeAllSessions(s.member.id);
	assert.equal(await m.getSession(tokens[1]), null);
});

test("safeNextPath only allows same-site paths", () => {
	assert.equal(safeNextPath("/account?x=1"), "/account?x=1");
	for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil", "/a\nb", "", null, undefined]) {
		assert.equal(safeNextPath(bad), null, String(bad));
	}
	assert.equal(normalizeEmail("  A@B.co "), "a@b.co");
	assert.equal(normalizeEmail("a@b"), null);
});

test("createLoginLink: a one-time link without an email, same verify flow", async () => {
	const { m, sent, advance } = setup();
	const link = await m.createLoginLink({ email: " New@Example.com ", origin: "https://example.com", next: "/account" });
	assert.ok(link.ok);
	assert.equal(sent.length, 0, "nothing is emailed");
	assert.ok(link.url.startsWith("https://example.com/login/verify?token="));
	assert.equal(new URL(link.url).searchParams.get("token"), link.token);
	assert.deepEqual(await m.peekLoginLink(link.token), { email: "new@example.com" });
	const r = await m.consumeLoginLink(link.token);
	assert.ok(r.ok);
	assert.equal(r.member.email, "new@example.com");
	assert.equal(r.next, "/account");
	assert.deepEqual(await m.consumeLoginLink(link.token), { ok: false, reason: "invalid_or_expired" });

	// Expires like an emailed link, and rejects bad addresses.
	const late = await m.createLoginLink({ email: "late@example.com", origin: "https://example.com" });
	assert.ok(late.ok);
	advance(16 * 60 * 1000);
	assert.equal(await m.peekLoginLink(late.token), null);
	assert.deepEqual(await m.createLoginLink({ email: "nope", origin: "https://example.com" }), { ok: false, reason: "invalid_email" });
});
