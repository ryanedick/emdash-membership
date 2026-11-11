/**
 * Members → Connections: the keys the plugin needs (Stripe, Turnstile),
 * entered here instead of environment variables. EmDash stores them
 * encrypted; this page never shows a saved secret, only whether it's set,
 * where it comes from, and its last four characters.
 */
import { getLifecycleSettings } from "../lifecycle.ts";
import { clearSecretsCache, ENV_FALLBACKS, getMembershipSecrets, maskSecret, SETTINGS_SCHEMA, type SettingKey, stripeMode } from "../settings.ts";
import { BILLING_WEBHOOK_EVENTS, stripeClientFor } from "../stripe.ts";
import { type AdminResponse, actions, banner, type Block, button, context, type Ctx, divider, form, header, type Interaction, str, text } from "./blocks.ts";

/** Restricted-key permissions the plugin uses, for the help text. */
export const STRIPE_KEY_PERMISSIONS = {
	write: ["Customers", "Checkout Sessions", "Customer portal", "Subscriptions", "Products", "Prices", "Coupons", "Promotion codes", "Webhook Endpoints"],
	read: ["Invoices", "Charges", "Payment Intents"],
};

const DEFAULT_WEBHOOK_PATH = "/api/stripe/webhook";

/** Block Kit's write-only input: the value is never sent to the browser, only whether one is set. Blank keeps it. */
const secret = (action_id: string, label: string, placeholder: string, current: string | null): Block => ({
	type: "secret_input",
	action_id,
	label,
	placeholder,
	has_value: !!current,
});

async function secretsFor(c: Ctx) {
	return getMembershipSecrets({
		read: async (key) => (c.settings ? await c.settings.get(key).catch(() => null) : null),
		...(c.envFallback ? { env: c.envFallback } : {}),
	});
}

function sourceLabel(src: "admin" | "env" | null) {
	return src === "admin" ? "saved here" : src === "env" ? "from an environment variable" : "not set";
}

export async function connectionsPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const s = await secretsFor(c);
	const mode = stripeMode(s.stripeSecretKey);
	const lifecycle = await getLifecycleSettings(c.db);
	const keys = Object.keys(SETTINGS_SCHEMA) as SettingKey[];
	return {
		blocks: [
			header("Connections"),
			context("Keys for Stripe and Cloudflare Turnstile. Saved keys are encrypted by EmDash and never shown again; to change one, save a new value. A key saved here takes over from an environment variable of the same purpose."),
			...(!c.settings ? [banner("Settings storage isn't available", "Open this page from the EmDash admin to save keys.", "alert")] : []),
			...extra,
			{
				type: "table",
				columns: [
					{ key: "name", label: "Key" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "value", label: "Value" },
					{ key: "where", label: "Source" },
					{ key: "clear", label: "", format: "element" },
				],
				rows: keys.map((k) => ({
					name: SETTINGS_SCHEMA[k].label,
					status: s[k] ? (k === "stripeSecretKey" && mode ? mode : "set") : "missing",
					value: SETTINGS_SCHEMA[k].type === "secret" ? maskSecret(s[k]) : (s[k] ?? "—"),
					where: s.source[k] === "env" ? `${sourceLabel("env")} (${ENV_FALLBACKS[k]})` : sourceLabel(s.source[k]),
					clear: s.source[k] === "admin" ? button("Clear", `conn:clear:${k}`, { confirm: { title: `Clear the saved ${SETTINGS_SCHEMA[k].label}?`, text: "Anything that uses it stops working until a new one is saved (or an environment variable takes over).", confirm: "Clear" } }) : "",
				})),
			},
			header("Stripe"),
			...(mode === "test" ? [banner("Test mode", "This is a test key: no real money moves. Save a live key when you're ready to take payments.")] : []),
			form(
				"stripe",
				[
					secret("stripeSecretKey", "Secret key", "rk_live_… or rk_test_…", s.stripeSecretKey),
					secret("stripeWebhookSecret", "Webhook signing secret (optional: created for you below)", "whsec_…", s.stripeWebhookSecret),
				],
				"Save Stripe keys",
				"conn:save-stripe",
			),
			context(
				`Create a restricted key in the Stripe Dashboard (Developers → API keys → Create restricted key) with Write access to ${STRIPE_KEY_PERMISSIONS.write.join(", ")}, and Read access to ${STRIPE_KEY_PERMISSIONS.read.join(", ")}.`,
			),
			actions(button("Test connection", "conn:test")),
			header("Stripe webhook"),
			context(`Stripe tells your site about payments through a webhook. This creates the endpoint in Stripe with the ${BILLING_WEBHOOK_EVENTS.length} events the plugin handles, and saves its signing secret here.`),
			form(
				"webhook",
				[text("site_url", "Site address", lifecycle.siteUrl || "", { placeholder: "https://example.com" }), text("path", "Webhook route on your site", DEFAULT_WEBHOOK_PATH)],
				"Create webhook in Stripe",
				"conn:webhook",
			),
			divider,
			header("Cloudflare Turnstile"),
			context("Optional bot protection for the sign-in form. Create a widget in the Cloudflare dashboard (Turnstile → Add widget) for your site's hostname and paste both keys."),
			form(
				"turnstile",
				[
					text("turnstileSiteKey", "Site key", s.source.turnstileSiteKey === "admin" ? s.turnstileSiteKey : "", { placeholder: "0x4AAAA…" }),
					secret("turnstileSecret", "Secret key", "0x4AAAA…", s.turnstileSecret),
				],
				"Save Turnstile keys",
				"conn:save-turnstile",
			),
		],
	};
}

function settingsError(err: unknown): string {
	const e = err as { code?: string; message?: string };
	if (e?.code?.startsWith("PLUGIN_SETTING_ENCRYPTION_KEY")) {
		return "EmDash can't encrypt secrets: the EMDASH_ENCRYPTION_KEY environment variable is missing or invalid. Generate one with `npx emdash secrets generate` and add it to the site's environment.";
	}
	return e?.message ?? String(err);
}

/** Handles `conn:*` actions; null for anything else. */
export async function connectionsAction(c: Ctx, i: Interaction): Promise<AdminResponse | null> {
	const [area, verb, ...rest] = (i.action_id ?? "").split(":");
	if (area !== "conn") return null;
	const v = i.values ?? {};
	const ok = async (message: string, extra: Block[] = []) => ({ ...(await connectionsPage(c, extra)), toast: { type: "success" as const, message } });
	const fail = async (message: string, extra: Block[] = []) => ({ ...(await connectionsPage(c, extra)), toast: { type: "error" as const, message } });
	const save = async (pairs: [SettingKey, string][]) => {
		if (!c.settings) throw new Error("Settings storage isn't available here.");
		for (const [k, val] of pairs) if (val) await c.settings.set(k, val);
		clearSecretsCache();
	};

	try {
		if (verb === "save-stripe") {
			const key = str(v.stripeSecretKey);
			const whsec = str(v.stripeWebhookSecret);
			if (key && !/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) return fail("That doesn't look like a Stripe secret key (sk_… or rk_…). Publishable keys (pk_…) won't work.");
			if (whsec && !/^whsec_[A-Za-z0-9]+$/.test(whsec)) return fail("Webhook signing secrets start with whsec_.");
			if (!key && !whsec) return fail("Nothing to save: both fields were empty.");
			await save([
				["stripeSecretKey", key],
				["stripeWebhookSecret", whsec],
			]);
			return ok(key ? `Saved the ${stripeMode(key)} key. Use "Test connection" to check it.` : "Saved the webhook secret.");
		}
		if (verb === "save-turnstile") {
			const site = str(v.turnstileSiteKey);
			const secret = str(v.turnstileSecret);
			if (!site && !secret) return fail("Nothing to save: both fields were empty.");
			await save([
				["turnstileSiteKey", site],
				["turnstileSecret", secret],
			]);
			return ok("Saved the Turnstile keys.");
		}
		if (verb === "clear") {
			const key = rest[0] as SettingKey;
			if (!(key in SETTINGS_SCHEMA) || !c.settings) return fail("Unknown setting.");
			await c.settings.delete(key);
			clearSecretsCache();
			return ok(`Cleared the ${SETTINGS_SCHEMA[key].label}.`);
		}
		if (verb === "test") {
			const s = await secretsFor(c);
			if (!s.stripeSecretKey) return fail("Save a Stripe secret key first.");
			const stripe = c.stripeFactory ? c.stripeFactory(s.stripeSecretKey) : await stripeClientFor(s.stripeSecretKey);
			try {
				await stripe.prices.list({ limit: 1 });
			} catch (err) {
				return fail(`Stripe refused the key: ${(err as Error)?.message ?? err}`);
			}
			const problems: string[] = [];
			try {
				await stripe.webhookEndpoints.list({ limit: 1 });
			} catch {
				problems.push("it can't read webhook endpoints (give it Webhook Endpoints access to create the webhook here)");
			}
			if (!s.stripeWebhookSecret) problems.push("the webhook signing secret isn't set yet");
			return problems.length
				? ok(`The ${stripeMode(s.stripeSecretKey)} key works, but ${problems.join(", and ")}.`)
				: ok(`Connected to Stripe in ${stripeMode(s.stripeSecretKey)} mode. Everything's set.`);
		}
		if (verb === "webhook") {
			const s = await secretsFor(c);
			if (!s.stripeSecretKey) return fail("Save a Stripe secret key first.");
			const site = str(v.site_url).replace(/\/$/, "");
			const path = str(v.path) || DEFAULT_WEBHOOK_PATH;
			let url: URL;
			try {
				url = new URL(path.startsWith("/") ? path : `/${path}`, site);
			} catch {
				return fail("Enter your site's address, like https://example.com.");
			}
			if (url.protocol !== "https:") return fail("Stripe needs an https address.");
			const stripe = c.stripeFactory ? c.stripeFactory(s.stripeSecretKey) : await stripeClientFor(s.stripeSecretKey);
			// Replace an endpoint we made before for the same URL (its secret can't be read back).
			const replaced: string[] = [];
			for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
				if (ep.url === url.toString()) {
					await stripe.webhookEndpoints.del(ep.id);
					replaced.push(ep.id);
				}
			}
			const endpoint = await stripe.webhookEndpoints.create({
				url: url.toString(),
				enabled_events: [...BILLING_WEBHOOK_EVENTS],
				description: "Memberships (emdash-memberships)",
				metadata: { created_by: "emdash-memberships" },
			});
			if (!endpoint.secret) return fail("Stripe created the endpoint but didn't return its signing secret.");
			await save([["stripeWebhookSecret", endpoint.secret]]);
			return ok(
				`Webhook created for ${url.toString()} with ${BILLING_WEBHOOK_EVENTS.length} events, and its signing secret saved.${replaced.length ? ` Replaced ${replaced.length} older endpoint(s) for the same address.` : ""}`,
			);
		}
	} catch (err) {
		return fail(settingsError(err));
	}
	return null;
}
