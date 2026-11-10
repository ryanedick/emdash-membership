/**
 * EmDash native plugin runtime (loaded in the Worker via the descriptor's
 * `entrypoint`). Adds the Members admin (Block Kit), a dashboard widget and
 * MCP tools for agents. Sign-in, sessions and Stripe stay in your site's
 * routes (`emdash-memberships/astro`); this is the staff side only.
 */
import { definePlugin } from "emdash";
import { z } from "zod";
import { getMemberDetail, listMembers, memberStats } from "../admin.ts";
import type { Db } from "../db.ts";
import { grantProTime } from "../grants.ts";
import { handleAdmin } from "./admin.ts";
import { ADMIN_PAGES, ADMIN_WIDGETS, PLUGIN_ID, PLUGIN_VERSION } from "./index.ts";
import type { PluginOptions } from "./options.ts";

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

const findInput = z.object({
	query: z.string().max(200).optional().describe("Part of the email address"),
	plan: z.enum(["free", "pro"]).optional(),
	earlyOnly: z.boolean().optional().describe("Only members with the early-member badge"),
	limit: z.number().int().min(1).max(100).optional(),
});
const idInput = z.object({ memberId: z.string().min(1) });
const grantInput = z.object({
	email: z.string().email(),
	days: z.number().positive().max(3650).describe("Days of Pro; stacks after any time they already have"),
	reason: z.string().max(200).optional(),
	key: z.string().min(1).max(200).optional().describe("Idempotency key; the same key never grants twice. Default: a new one"),
});
const empty = z.object({});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const r = schema.safeParse(input ?? {});
	if (!r.success) throw new Error(`Invalid input: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
	return r.data;
}

const isoOrNull = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export function createPlugin(options: PluginOptions = {}) {
	const permission = (options.permission ?? "users:manage") as "users:manage";
	const proStatuses = options.proStatuses;

	const route = <T>(schema: z.ZodType<T>, fn: (db: Db, input: T) => Promise<unknown>) => ({
		permission,
		handler: async (ctx: { input: unknown }) => fn(await database(options), parse(schema, ctx.input)),
	});

	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: [],
		admin: { pages: ADMIN_PAGES, widgets: ADMIN_WIDGETS },
		routes: {
			admin: {
				permission,
				handler: async (ctx) => handleAdmin(await database(options), ctx.input, options),
			},
			"mcp/stats": route(empty, async (db) => memberStats(db, { proStatuses, planValues: options.planValues }).then(({ growth: _g, ...s }) => s)),
			"mcp/find": route(findInput, async (db, i) => {
				const r = await listMembers(db, { search: i.query, plan: i.plan, earlyOnly: i.earlyOnly, limit: i.limit ?? 25 });
				return {
					total: r.total,
					items: r.items.map((m) => ({
						id: m.id,
						email: m.email,
						plan: m.plan,
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
					grants: d.grants.map((g) => ({ key: g.key, reason: g.reason, startsAt: isoOrNull(g.startsAt), endsAt: isoOrNull(g.endsAt), revoked: !!g.revokedAt })),
				};
			}),
			"mcp/grant": route(grantInput, async (db, i) => {
				const r = await grantProTime(db, { email: i.email, days: i.days, key: i.key ?? `mcp:${crypto.randomUUID()}`, reason: i.reason ?? "Given by an agent", proStatuses });
				if (!r.ok) throw new Error(r.reason);
				return { created: r.created, plan: r.plan, memberId: r.grant.memberId, endsAt: isoOrNull(r.grant.endsAt) };
			}),
		},
		mcp: {
			tools: {
				members_stats: { description: "Membership health: member counts, Pro vs Free, paying subscriptions, early members, comp-only Pro, MRR at list price (if configured).", route: "mcp/stats", input: empty },
				members_find: { description: "Search members by email, plan or early-member badge, newest first.", route: "mcp/find", input: findInput },
				members_get: { description: "One member's full record: plan and why, subscriptions, early access, comp grants, signed-in devices.", route: "mcp/member", input: idInput },
				members_grant_pro: { description: "Give an email address N days of Pro (comp time). Stacks after existing time; idempotent per key.", route: "mcp/grant", input: grantInput, destructive: true },
			},
		},
	});
}

export default createPlugin;
