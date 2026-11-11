/**
 * EmDash native plugin runtime (loaded in the Worker via the descriptor's
 * `entrypoint`). Adds the Members admin (Block Kit), a dashboard widget, a
 * scheduled job (lifecycle emails, expiring comp time) and MCP tools.
 * Sign-in, sessions, checkout and the Stripe webhook stay in your site's
 * routes (`emdash-memberships/astro`); this is the staff side.
 */
import { definePlugin } from "emdash";
import type Stripe from "stripe";
import { z } from "zod";
import { getMemberDetail, listMembers, memberStats } from "../admin.ts";
import type { Db } from "../db.ts";
import { expireGrants, grantProTime } from "../grants.ts";
import { listEvents, processWebhooks } from "../events.ts";
import { processOutbox } from "../lifecycle.ts";
import { checkAccess, listRules } from "../rules.ts";
import { listPlans, listPrices } from "../plans.ts";
import { conversionReport, revenueReport } from "../revenue.ts";
import type { EmailTransport } from "../transport.ts";
import { type CloudflareSendEmailBinding, cloudflareEmailTransport } from "../transports/cloudflare.ts";
import { getMembershipSecrets, SETTINGS_SCHEMA } from "../settings.ts";
import { stripeClientFor } from "../stripe.ts";
import { handleAdmin } from "./admin.ts";
import { ADMIN_PAGES, ADMIN_WIDGETS, PLUGIN_ID, PLUGIN_VERSION } from "./index.ts";
import type { PluginOptions } from "./options.ts";

const TICK = "memberships-tick";

async function cloudflareEnv(): Promise<Record<string, unknown>> {
	try {
		return ((await import("cloudflare:workers" as string)) as { env: Record<string, unknown> }).env ?? {};
	} catch {
		return {};
	}
}

async function database(options: PluginOptions): Promise<Db> {
	const name = options.d1Binding ?? "DB";
	const db = (await cloudflareEnv())[name] as Db | undefined;
	if (!db) throw new Error(`emdash-memberships: D1 binding "${name}" not found`);
	return db;
}

/** Env with the configured Stripe variable name mapped onto the standard one. */
async function fallbackEnv(options: PluginOptions): Promise<Record<string, unknown>> {
	const env = await cloudflareEnv();
	return options.stripeSecretEnv ? { ...env, STRIPE_SECRET_KEY: env[options.stripeSecretEnv] } : env;
}

type SettingsCtx = { settings?: { get<T>(key: string): Promise<T | null> } };

/** A Stripe client from the key saved in the admin (or the environment), or null when none is set. */
async function stripeFor(options: PluginOptions, ctx: SettingsCtx): Promise<Stripe | null> {
	const secrets = await getMembershipSecrets({ read: async (k) => (ctx.settings ? await ctx.settings.get(k).catch(() => null) : null), env: await fallbackEnv(options) });
	if (!secrets.stripeSecretKey) return null;
	try {
		return await stripeClientFor(secrets.stripeSecretKey);
	} catch {
		return null;
	}
}

async function transportFor(options: PluginOptions): Promise<EmailTransport | null> {
	const name = options.emailBinding ?? "EMAIL";
	if (!name) return null;
	const binding = (await cloudflareEnv())[name] as CloudflareSendEmailBinding | undefined;
	return binding ? cloudflareEmailTransport(binding) : null;
}

const findInput = z.object({
	query: z.string().max(200).optional().describe("Part of the email address"),
	plan: z.enum(["free", "pro"]).optional().describe("pro = any paid plan"),
	earlyOnly: z.boolean().optional().describe("Only members with the early-member badge"),
	limit: z.number().int().min(1).max(100).optional(),
});
const idInput = z.object({ memberId: z.string().min(1) });
const grantInput = z.object({
	email: z.string().email(),
	days: z.number().positive().max(3650).describe("Days of the plan; stacks after any time they already have on it"),
	plan: z.string().max(48).optional().describe("Plan id; default pro (see members_plans)"),
	reason: z.string().max(200).optional(),
	key: z.string().min(1).max(200).optional().describe("Idempotency key; the same key never grants twice. Default: a new one"),
});
const empty = z.object({});
const accessInput = z.object({
	memberId: z.string().optional().describe("Member to check as; omit for a signed-out visitor"),
	collection: z.string().optional(),
	slug: z.string().optional(),
	terms: z.array(z.string()).optional().describe('"taxonomy:term" pairs'),
	path: z.string().optional(),
	fields: z.record(z.string(), z.unknown()).optional().describe("Date and flag fields the rules read"),
});
const eventsInput = z.object({ memberId: z.string().optional(), type: z.string().optional(), limit: z.number().int().min(1).max(200).optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const r = schema.safeParse(input ?? {});
	if (!r.success) throw new Error(`Invalid input: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
	return r.data;
}

const isoOrNull = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export function createPlugin(options: PluginOptions = {}) {
	const permission = (options.permission ?? "users:manage") as "users:manage";
	const proStatuses = options.proStatuses;
	const schedule = options.cronSchedule ?? "*/5 * * * *";

	const route = <T>(schema: z.ZodType<T>, fn: (db: Db, input: T) => Promise<unknown>) => ({
		permission,
		handler: async (ctx: { input: unknown }) => fn(await database(options), parse(schema, ctx.input)),
	});

	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: [],
		admin: { pages: ADMIN_PAGES, widgets: ADMIN_WIDGETS, settingsSchema: SETTINGS_SCHEMA },
		hooks: {
			// EmDash disables a plugin whose activate hook throws, so failures are only logged.
			"plugin:activate": async (_event, ctx) => {
				try {
					await ctx.cron?.schedule(TICK, { schedule });
				} catch (err) {
					ctx.log.error("memberships: could not schedule the cron", { error: String(err) });
				}
			},
			cron: {
				timeout: 50_000,
				errorPolicy: "continue",
				handler: async (event, ctx) => {
					if (event.name !== TICK) return;
					const db = await database(options);
					const expired = await expireGrants(db, { proStatuses });
					const transport = await transportFor(options);
					const mail = transport ? await processOutbox({ db, transport }) : null;
					const hooks = await processWebhooks({ db });
					if (expired.length || mail?.sent || mail?.failed || hooks.delivered || hooks.failed) {
						ctx.log.info("memberships tick", { compExpired: expired.length, ...mail, webhooksDelivered: hooks.delivered, webhooksFailed: hooks.failed });
					}
				},
			},
		},
		routes: {
			admin: {
				permission,
				handler: async (ctx) => {
					const [db, stripe, transport, env] = await Promise.all([database(options), stripeFor(options, ctx), transportFor(options), fallbackEnv(options)]);
					const user = (ctx as { user?: { email?: string; id?: string } }).user;
					return handleAdmin(db, ctx.input, options, { stripe, transport, actor: user?.email ?? user?.id ?? null, settings: ctx.settings, envFallback: env });
				},
			},
			"mcp/stats": route(empty, async (db) => {
				const [{ growth: _g, ...members }, revenue, conversion] = await Promise.all([
					memberStats(db, { proStatuses, planValues: options.planValues }),
					revenueReport(db),
					conversionReport(db),
				]);
				return { members, revenue: { ...revenue, history: undefined }, conversion };
			}),
			"mcp/plans": route(empty, async (db) => {
				const [plans, prices] = await Promise.all([listPlans(db, { includeArchived: true }), listPrices(db)]);
				return plans.map((p) => ({
					...p,
					prices: prices
						.filter((x) => x.planId === p.id)
						.map((x) => ({ lookupKey: x.lookupKey, kind: x.kind, amount: x.amount, currency: x.currency, interval: x.interval, trialDays: x.trialDays, active: x.active })),
				}));
			}),
			"mcp/find": route(findInput, async (db, i) => {
				const r = await listMembers(db, { search: i.query, plan: i.plan, earlyOnly: i.earlyOnly, limit: i.limit ?? 25 });
				return {
					total: r.total,
					items: r.items.map((m) => ({
						id: m.id,
						email: m.email,
						paid: m.plan === "pro",
						earlyMember: m.earlyMember,
						subscription: m.subscriptionStatus,
						joined: isoOrNull(m.createdAt),
						lastSignIn: isoOrNull(m.lastLoginAt),
					})),
				};
			}),
			"mcp/member": route(idInput, async (db, i) => {
				const d = await getMemberDetail(db, i.memberId);
				if (!d) throw new Error("Member not found");
				return {
					...d,
					member: { ...d.member, createdAt: isoOrNull(d.member.createdAt), lastLoginAt: isoOrNull(d.member.lastLoginAt) },
					grants: d.grants.map((g) => ({ key: g.key, plan: g.planId, reason: g.reason, startsAt: isoOrNull(g.startsAt), endsAt: isoOrNull(g.endsAt), revoked: !!g.revokedAt })),
				};
			}),
			"mcp/rules": route(empty, async (db) => listRules(db)),
			"mcp/check-access": route(accessInput, async (db, i) => {
				const m = i.memberId
					? await db.prepare(`SELECT m.plan, m.created_at, a.entitlements FROM mbr_members m LEFT JOIN mbr_member_access a ON a.member_id = m.id WHERE m.id = ?`).bind(i.memberId).first<{ plan: string; created_at: number; entitlements: string | null }>()
					: null;
				const member = m ? { plan: m.plan, createdAt: m.created_at, entitlements: JSON.parse(m.entitlements ?? "[]") as string[] } : null;
				const { rule, ...decision } = await checkAccess(db, member, i);
				return { ...decision, rule: rule ? { id: rule.id, name: rule.name } : null };
			}),
			"mcp/events": route(eventsInput, async (db, i) => listEvents(db, { memberId: i.memberId, type: i.type, limit: i.limit ?? 50 })),
			"mcp/grant": route(grantInput, async (db, i) => {
				const r = await grantProTime(db, { email: i.email, days: i.days, plan: i.plan, key: i.key ?? `mcp:${crypto.randomUUID()}`, reason: i.reason ?? "Given by an agent", proStatuses });
				if (!r.ok) throw new Error(r.reason);
				return { created: r.created, paid: r.plan === "pro", memberId: r.grant.memberId, plan: r.grant.planId, endsAt: isoOrNull(r.grant.endsAt) };
			}),
		},
		mcp: {
			tools: {
				members_stats: { description: "Membership health: member counts, paid vs free, subscriptions, early members, MRR/ARR and 30-day movements, conversion.", route: "mcp/stats", input: empty },
				members_plans: { description: "Plans with their entitlements and prices (lookup keys, amounts, trials).", route: "mcp/plans", input: empty },
				members_find: { description: "Search members by email, paid/free or early-member badge, newest first.", route: "mcp/find", input: findInput },
				members_get: { description: "One member's full record: plan and why, subscriptions, early access, comp grants, signed-in devices.", route: "mcp/member", input: idInput },
				members_rules: { description: "The access rules: what each collection, term, entry or path needs, with free windows and drip.", route: "mcp/rules", input: empty },
				members_check_access: { description: "Decide whether a member (or a signed-out visitor) can see a piece of content under the access rules, and why.", route: "mcp/check-access", input: accessInput },
				members_events: { description: "Membership events (sign-ups, plan changes, payments, gifts, teams…), newest first, optionally for one member or type.", route: "mcp/events", input: eventsInput },
				members_grant_pro: { description: "Give an email address N days of a paid plan (comp time). Stacks after existing time on that plan; idempotent per key.", route: "mcp/grant", input: grantInput, destructive: true },
			},
		},
	});
}

export default createPlugin;
