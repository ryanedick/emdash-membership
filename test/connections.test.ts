import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSchema } from "../src/db.ts";
import { handleAdmin } from "../src/plugin/admin.ts";
import { clearSecretsCache, getMembershipSecrets, maskSecret, stripeMode } from "../src/settings.ts";
import { BILLING_WEBHOOK_EVENTS, createBillingFromSettings } from "../src/stripe.ts";
import { fakeStripe } from "./fake-stripe.ts";
import { sqliteDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 11, 1, 12);
type Block = Record<string, unknown>;

/** An in-memory stand-in for EmDash's ctx.settings. */
function memorySettings(fail?: { code: string }) {
	const store = new Map<string, unknown>();
	return {
		store,
		async get<T>(key: string) {
			return (store.get(key) as T) ?? null;
		},
		async set(key: string, value: unknown) {
			if (fail) throw Object.assign(new Error("no key"), fail);
			store.set(key, value);
		},
		async delete(key: string) {
			return store.delete(key);
		},
	};
}

test("secrets: admin value wins, env is the fallback, nothing leaks in masks", async () => {
	const stored = new Map<string, string>([["stripeSecretKey", "rk_live_ADMIN1234"]]);
	const s = await getMembershipSecrets({
		read: async (k) => stored.get(k) ?? null,
		env: { STRIPE_SECRET_KEY: "sk_test_ENV", STRIPE_WEBHOOK_SECRET: "whsec_ENV", TURNSTILE_SITE_KEY: " 0xSITE " },
	});
	assert.equal(s.stripeSecretKey, "rk_live_ADMIN1234");
	assert.equal(s.source.stripeSecretKey, "admin");
	assert.equal(s.stripeWebhookSecret, "whsec_ENV");
	assert.equal(s.source.stripeWebhookSecret, "env");
	assert.equal(s.turnstileSiteKey, "0xSITE");
	assert.equal(s.turnstileSecret, null);
	assert.equal(s.source.turnstileSecret, null);
	assert.equal(stripeMode("rk_live_x"), "live");
	assert.equal(stripeMode("sk_test_x"), "test");
	assert.equal(stripeMode("pk_live_x"), null);
	assert.equal(maskSecret("rk_live_abcdefgh1234"), "rk_live_…1234");
	assert.equal(maskSecret(null), "not set");
	// A broken read (e.g. no encryption key) falls back to env instead of failing
	const broken = await getMembershipSecrets({ read: async () => { throw new Error("decrypt failed"); }, env: { STRIPE_SECRET_KEY: "sk_test_ENV" } });
	assert.equal(broken.stripeSecretKey, "sk_test_ENV");
});

test("createBillingFromSettings: null until a key exists; webhooks wait for the signing secret", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	assert.equal(await createBillingFromSettings({ db, secrets: { read: async () => null, env: {} } }), null);
	const f = fakeStripe();
	const billing = await createBillingFromSettings({ db, stripe: f.client, secrets: { read: async () => null, env: {} } });
	assert.ok(billing);
	assert.deepEqual(await billing.handleWebhook("{}", "valid"), { status: 503, body: "webhook signing secret not set" });
	const ready = await createBillingFromSettings({ db, stripe: f.client, secrets: { read: async (k) => (k === "stripeWebhookSecret" ? "whsec_x" : null), env: {} } });
	assert.deepEqual(await ready!.handleWebhook(JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } }), "valid"), { status: 200, body: "ok" });
});

test("Connections page: save, test, create the webhook, clear", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	const f = fakeStripe();
	const settings = memorySettings();
	const admin = (input: Record<string, unknown>) =>
		handleAdmin(db, input, {}, { settings, envFallback: {}, stripeFactory: () => f.client, now: T0, actor: "owner@example.com" });
	clearSecretsCache();

	const empty = await admin({ type: "page_load", page: "/connections" });
	assert.equal(empty.toast, undefined);
	const inputs = JSON.stringify(empty.blocks);
	assert.ok(inputs.includes('"type":"secret_input"'));
	assert.ok(inputs.includes('"has_value":false'));

	assert.match((await admin({ type: "form_submit", action_id: "conn:save-stripe", values: { stripeSecretKey: "pk_live_nope" } })).toast!.message, /Publishable keys/);
	assert.match((await admin({ type: "form_submit", action_id: "conn:test" })).toast!.message, /Save a Stripe secret key first/);

	const saved = await admin({ type: "form_submit", action_id: "conn:save-stripe", values: { stripeSecretKey: "rk_test_SECRET9876", stripeWebhookSecret: "" } });
	assert.equal(saved.toast?.type, "success");
	assert.equal(settings.store.get("stripeSecretKey"), "rk_test_SECRET9876");
	assert.equal(settings.store.has("stripeWebhookSecret"), false, "a blank field keeps (doesn't overwrite) the value");
	const page = JSON.stringify(saved.blocks);
	assert.ok(!page.includes("SECRET9876"), "the saved secret never goes back to the browser");
	assert.ok(page.includes("rk_test_…9876"));
	assert.ok(page.includes('"has_value":true'));
	assert.ok(page.includes("Test mode"));

	const tested = await admin({ type: "form_submit", action_id: "conn:test" });
	assert.match(tested.toast!.message, /works, but the webhook signing secret isn't set yet/);

	assert.match((await admin({ type: "form_submit", action_id: "conn:webhook", values: { site_url: "http://example.com" } })).toast!.message, /https/);
	const hook = await admin({ type: "form_submit", action_id: "conn:webhook", values: { site_url: "https://example.com/", path: "/api/stripe/webhook" } });
	assert.equal(hook.toast?.type, "success", hook.toast?.message);
	const [ep] = [...(f as unknown as { endpoints: Map<string, Record<string, unknown>> }).endpoints.values()];
	assert.equal(ep.url, "https://example.com/api/stripe/webhook");
	assert.deepEqual(ep.enabled_events, [...BILLING_WEBHOOK_EVENTS]);
	assert.equal(settings.store.get("stripeWebhookSecret"), ep.secret, "the endpoint's signing secret is saved");

	// Again: the old endpoint for the same URL is replaced, not duplicated
	const again = await admin({ type: "form_submit", action_id: "conn:webhook", values: { site_url: "https://example.com", path: "/api/stripe/webhook" } });
	assert.match(again.toast!.message, /Replaced 1 older endpoint/);
	assert.equal((f as unknown as { endpoints: Map<string, unknown> }).endpoints.size, 1);
	assert.match((await admin({ type: "form_submit", action_id: "conn:test" })).toast!.message, /Connected to Stripe in test mode/);

	assert.equal((await admin({ type: "form_submit", action_id: "conn:save-turnstile", values: { turnstileSiteKey: "0xSITE", turnstileSecret: "0xSECRET" } })).toast?.type, "success");
	assert.equal((await admin({ type: "block_action", action_id: "conn:clear:turnstileSecret" })).toast?.message, "Cleared the Cloudflare Turnstile secret key.");
	assert.equal(settings.store.has("turnstileSecret"), false);
});

test("Connections explains a missing encryption key, and env-provided keys show their source", async () => {
	const db = sqliteDb();
	await ensureSchema(db);
	const settings = memorySettings({ code: "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING" });
	const r = await handleAdmin(db, { type: "form_submit", action_id: "conn:save-stripe", values: { stripeSecretKey: "rk_live_abc123" } }, {}, { settings, envFallback: { STRIPE_SECRET_KEY: "sk_live_ENVKEY1" }, now: T0 });
	assert.match(r.toast!.message, /EMDASH_ENCRYPTION_KEY/);
	const rows = (r.blocks.find((b: Block) => b.type === "table") as { rows: Record<string, string>[] }).rows;
	assert.match(rows[0].where, /environment variable \(STRIPE_SECRET_KEY\)/);
	assert.equal(rows[0].status, "live");
});
