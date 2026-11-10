import assert from "node:assert/strict";
import { test } from "node:test";
import { membershipsAstro } from "../src/astro.ts";
import type { LoginEmail } from "../src/email.ts";
import { sqliteDb } from "./helpers.ts";

/** Just enough of Astro's APIContext for the routes. */
function fakeContext(method: string, path: string, opts: { form?: Record<string, string>; cookies?: Record<string, string> } = {}) {
	const url = new URL(path, "https://example.com");
	const jar = new Map(Object.entries(opts.cookies ?? {}));
	const set: Record<string, { value: string; options: unknown }> = {};
	const body = opts.form ? new URLSearchParams(opts.form) : undefined;
	const request = new Request(url, { method, body, headers: { "cf-connecting-ip": "203.0.113.1" } });
	const ctx = {
		request,
		url,
		locals: {} as Record<string, unknown>,
		cookies: {
			get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
			set: (n: string, value: string, options: unknown) => {
				jar.set(n, value);
				set[n] = { value, options };
			},
			delete: (n: string) => {
				jar.delete(n);
				set[n] = { value: "", options: "deleted" };
			},
		},
		redirect: (to: string, status = 302) => new Response(null, { status, headers: { Location: to } }),
	};
	return { ctx: ctx as never, set, jar, locals: ctx.locals };
}

function setup(dev = false) {
	const db = sqliteDb();
	const sent: LoginEmail[] = [];
	const members = membershipsAstro({ db, sender: { send: async (e) => void sent.push(e) }, dev });
	return { members, sent };
}

const location = (r: Response) => r.headers.get("Location");

test("login → verify → middleware → logout", async () => {
	const { members, sent } = setup();
	const login = await members.loginRoute(fakeContext("POST", "/api/auth/login", { form: { email: "a@example.com", next: "/tips" } }).ctx);
	assert.equal(login.status, 303);
	assert.equal(location(login), "/login/check");
	const token = new URL(sent[0].url).searchParams.get("token")!;

	const v = fakeContext("POST", "/api/auth/verify", { form: { token } });
	const verified = await members.verifyRoute(v.ctx);
	assert.equal(location(verified), "/tips");
	const cookie = v.set.mbr_session;
	assert.ok(cookie.value);
	assert.deepEqual(
		{ ...(cookie.options as object), expires: undefined },
		{ path: "/", httpOnly: true, secure: true, sameSite: "lax", expires: undefined },
	);

	const page = fakeContext("GET", "/account", { cookies: { mbr_session: cookie.value } });
	const res = (await members.middleware(page.ctx, async () => new Response("ok"))) as Response;
	assert.equal((page.locals.member as { email: string }).email, "a@example.com");
	assert.equal(res.headers.get("Cache-Control"), "private, no-store");

	const out = fakeContext("POST", "/api/auth/logout", { cookies: { mbr_session: cookie.value } });
	assert.equal(location(await members.logoutRoute(out.ctx)), "/");
	assert.equal(out.set.mbr_session.options, "deleted");

	const after = fakeContext("GET", "/account", { cookies: { mbr_session: cookie.value } });
	await members.middleware(after.ctx, async () => new Response("ok"));
	assert.equal(after.locals.member, undefined);
	assert.equal(after.set.mbr_session.options, "deleted");
});

test("login errors redirect back with a reason; honeypot pretends success", async () => {
	const { members, sent } = setup();
	const bad = await members.loginRoute(fakeContext("POST", "/x", { form: { email: "nope" } }).ctx);
	assert.equal(location(bad), "/login?error=email&email=nope");

	const bot = await members.loginRoute(fakeContext("POST", "/x", { form: { email: "a@example.com", website: "spam" } }).ctx);
	assert.equal(location(bot), "/login/check");
	assert.equal(sent.length, 0);

	const expired = await members.verifyRoute(fakeContext("POST", "/x", { form: { token: "nope" } }).ctx);
	assert.equal(location(expired), "/login?error=expired");
});

test("dev mode puts the link on the check page; verifyHuman can reject", async () => {
	const { members } = setup(true);
	const r = await members.loginRoute(fakeContext("POST", "/x", { form: { email: "a@example.com" } }).ctx);
	const dev = new URL(location(r)!, "https://example.com").searchParams.get("dev");
	assert.ok(dev?.startsWith("https://example.com/login/verify?token="));

	const strict = membershipsAstro({ db: sqliteDb(), sender: { send: async () => {} }, verifyHuman: () => false });
	const rejected = await strict.loginRoute(fakeContext("POST", "/x", { form: { email: "a@example.com" } }).ctx);
	assert.equal(location(rejected), "/login?error=verify&email=a%40example.com");
});

test("middleware skips EmDash admin paths", async () => {
	const { members } = setup();
	const admin = fakeContext("GET", "/_emdash/admin", { cookies: { mbr_session: "whatever" } });
	await members.middleware(admin.ctx, async () => new Response("ok"));
	assert.equal(admin.set.mbr_session, undefined);
});

test("checkout requires sign-in and an allowed offer", async () => {
	const { members } = setup();
	const routes = members.billingRoutes({
		billing: () => {
			throw new Error("not reached");
		},
		purchasable: () => ["pro_monthly"],
	});
	const anon = await routes.checkoutRoute(fakeContext("POST", "/x", { form: { offer: "pro_monthly" } }).ctx);
	assert.equal(location(anon), "/login?next=%2Fpricing");

	const c = fakeContext("POST", "/x", { form: { offer: "lifetime" } });
	(c.locals as Record<string, unknown>).member = { id: "m1", email: "a@example.com", plan: "free", createdAt: 0, lastLoginAt: null };
	assert.equal(location(await routes.checkoutRoute(c.ctx)), "/pricing?checkout=unavailable");

	const off = members.billingRoutes({ billing: () => ({}) as never, enabled: false });
	const hook = await off.webhookRoute(fakeContext("POST", "/x").ctx);
	assert.equal(hook.status, 503);
});
