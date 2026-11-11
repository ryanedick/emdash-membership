/**
 * Keys and secrets the plugin needs (Stripe, Turnstile), entered in the
 * EmDash admin instead of environment variables.
 *
 * The plugin declares them in `admin.settingsSchema`; EmDash stores fields of
 * type "secret" encrypted with the site's EMDASH_ENCRYPTION_KEY and never
 * sends them back to the browser. Site routes read them with EmDash's
 * `getPluginSetting()`, which decrypts on read. Environment variables still
 * work as a fallback, so existing deployments keep running unchanged; a value
 * saved in the admin wins over the environment.
 */

export const PLUGIN_ID = "emdash-memberships";

/** EmDash settings schema (rendered as a form under the plugin's settings, and used by the Connections page). */
export const SETTINGS_SCHEMA = {
	stripeSecretKey: {
		type: "secret",
		label: "Stripe secret key",
		description: "A restricted key (rk_live_… or rk_test_…) with the permissions listed on Members → Connections. Stored encrypted.",
	},
	stripeWebhookSecret: {
		type: "secret",
		label: "Stripe webhook signing secret",
		description: "whsec_…. Filled in for you when you create the webhook on Members → Connections.",
	},
	turnstileSiteKey: { type: "string", label: "Cloudflare Turnstile site key", description: "Optional. Protects the sign-in form from bots." },
	turnstileSecret: { type: "secret", label: "Cloudflare Turnstile secret key", description: "Optional. Stored encrypted." },
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

/** Environment variables used when a setting isn't saved in the admin. */
export const ENV_FALLBACKS: Record<SettingKey, string> = {
	stripeSecretKey: "STRIPE_SECRET_KEY",
	stripeWebhookSecret: "STRIPE_WEBHOOK_SECRET",
	turnstileSiteKey: "TURNSTILE_SITE_KEY",
	turnstileSecret: "TURNSTILE_SECRET_KEY",
};

export interface MembershipSecrets {
	stripeSecretKey: string | null;
	stripeWebhookSecret: string | null;
	turnstileSiteKey: string | null;
	turnstileSecret: string | null;
	/** Where each value came from */
	source: Record<SettingKey, "admin" | "env" | null>;
}

export interface SecretsOptions {
	/** Reads a stored setting. Default: EmDash's `getPluginSetting` (works during a request). */
	read?: (key: SettingKey) => Promise<unknown>;
	/** Environment for fallbacks. Default: `cloudflare:workers` env. */
	env?: Record<string, unknown>;
	/** Skip the short per-isolate cache */
	fresh?: boolean;
}

async function workersEnv(): Promise<Record<string, unknown>> {
	try {
		return ((await import("cloudflare:workers")) as { env: Record<string, unknown> }).env ?? {};
	} catch {
		return {};
	}
}

async function emdashRead(key: SettingKey): Promise<unknown> {
	try {
		const mod = (await import("emdash")) as { getPluginSetting?: (pluginId: string, key: string) => Promise<unknown> };
		return (await mod.getPluginSetting?.(PLUGIN_ID, key)) ?? null;
	} catch {
		// Outside an EmDash request (a cron, a test) or no encryption key: fall back to env.
		return null;
	}
}

let cache: { at: number; value: MembershipSecrets } | null = null;
const CACHE_MS = 30_000;

/** Forget cached values (after saving settings in this isolate). Other isolates refresh within 30 seconds. */
export function clearSecretsCache(): void {
	cache = null;
}

/** The plugin's keys: admin settings first, then environment variables. */
export async function getMembershipSecrets(opts: SecretsOptions = {}): Promise<MembershipSecrets> {
	const custom = !!(opts.read || opts.env);
	if (!custom && !opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
	const read = opts.read ?? emdashRead;
	const env = opts.env ?? (await workersEnv());
	const out = { source: {} } as MembershipSecrets;
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingKey[]) {
		let stored: unknown = null;
		try {
			stored = await read(key);
		} catch {
			stored = null;
		}
		const fromEnv = env[ENV_FALLBACKS[key]];
		if (typeof stored === "string" && stored.trim()) {
			out[key] = stored.trim();
			out.source[key] = "admin";
		} else if (typeof fromEnv === "string" && fromEnv.trim()) {
			out[key] = fromEnv.trim();
			out.source[key] = "env";
		} else {
			out[key] = null;
			out.source[key] = null;
		}
	}
	if (!custom) cache = { at: Date.now(), value: out };
	return out;
}

/** "live", "test" or null, from a Stripe key's prefix. */
export function stripeMode(key: string | null | undefined): "live" | "test" | null {
	if (!key) return null;
	if (/^(sk|rk)_live_/.test(key)) return "live";
	if (/^(sk|rk)_test_/.test(key)) return "test";
	return null;
}

/** A short, safe description of a stored secret, e.g. "rk_live_…4f2a". Never the whole value. */
export function maskSecret(v: string | null | undefined): string {
	if (!v) return "not set";
	const prefix = v.match(/^[a-z]+_(live_|test_)?/)?.[0] ?? "";
	return `${prefix}…${v.slice(-4)}`;
}
