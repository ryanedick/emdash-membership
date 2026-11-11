/**
 * Plans, prices and entitlements.
 *
 * A plan (e.g. "pro", "team") grants entitlements: plain strings your pages
 * check, like "archive" or "courses". A member holds plans through three
 * sources: a subscription to one of the plan's prices, a one-time purchase
 * that grants early access, or comp time. Their entitlements are the union of
 * the default (free) plan's and every held plan's, cached in
 * `mbr_member_access` so a page view is one query.
 *
 * Two plans are built in: `free` (the default, no entitlements) and `pro`
 * (entitlement "pro"). Sites from 0.2 keep working unchanged: `member.plan`
 * is still "pro" whenever any paid plan is held.
 */
import { type Db, type DbStatement, ensureSchema } from "./db.ts";
import { DEFAULT_PRO_STATUSES, statusList } from "./status.ts";

export interface MembershipPlan {
	/** Slug, e.g. "pro". Never changes once created. */
	id: string;
	name: string;
	description: string | null;
	entitlements: string[];
	/** False only for the free (default) plan */
	paid: boolean;
	/** Shown on pricing tables */
	visible: boolean;
	sortOrder: number;
	stripeProductId: string | null;
	archivedAt: number | null;
}

export interface PlanPrice {
	id: string;
	planId: string;
	/** Stripe Price lookup key; also what checkout takes */
	lookupKey: string;
	stripePriceId: string | null;
	kind: "recurring" | "one_time";
	/** In the smallest currency unit (cents) */
	amount: number;
	currency: string;
	interval: "month" | "year" | null;
	intervalCount: number;
	trialDays: number;
	/** One-time price that marks the buyer an early member (see paid launch) */
	grantsEarlyAccess: boolean;
	/** Capped offer: at most this many members can buy it ("founding 100"). Null = no cap. */
	maxMembers: number | null;
	/** Capped offer: not sold after this moment (ms). Null = no end. */
	availableUntil: number | null;
	/** Gift price: a one-time price that buys this many days of the plan for someone else. 0 = not a gift. */
	giftDays: number;
	/** Team price: billed per seat; checkout asks for a seat count and creates a team. */
	perSeat: boolean;
	active: boolean;
	syncError: string | null;
}

export interface MemberAccess {
	/** Paid plans held right now (the free plan is implied) */
	plans: string[];
	entitlements: string[];
	/** True when any paid plan is held: the 0.2 "pro" */
	paid: boolean;
}

export const FREE_PLAN = "free";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;

interface PlanRow {
	id: string;
	name: string;
	description: string | null;
	entitlements: string;
	paid: number;
	visible: number;
	sort_order: number;
	stripe_product_id: string | null;
	archived_at: number | null;
}

interface PriceRow {
	id: string;
	plan_id: string;
	lookup_key: string;
	stripe_price_id: string | null;
	kind: string;
	amount: number;
	currency: string;
	interval: string | null;
	interval_count: number;
	trial_days: number;
	grants_early_access: number;
	max_members: number | null;
	available_until: number | null;
	gift_days: number;
	per_seat: number;
	active: number;
	sync_error: string | null;
}

function parseList(json: string | null | undefined): string[] {
	try {
		const v = JSON.parse(json ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

const toPlan = (r: PlanRow): MembershipPlan => ({
	id: r.id,
	name: r.name,
	description: r.description,
	entitlements: parseList(r.entitlements),
	paid: !!r.paid,
	visible: !!r.visible,
	sortOrder: r.sort_order,
	stripeProductId: r.stripe_product_id,
	archivedAt: r.archived_at,
});

const toPrice = (r: PriceRow): PlanPrice => ({
	id: r.id,
	planId: r.plan_id,
	lookupKey: r.lookup_key,
	stripePriceId: r.stripe_price_id,
	kind: r.kind === "one_time" ? "one_time" : "recurring",
	amount: r.amount,
	currency: r.currency,
	interval: r.interval === "year" ? "year" : r.interval === "month" ? "month" : null,
	intervalCount: r.interval_count,
	trialDays: r.trial_days,
	grantsEarlyAccess: !!r.grants_early_access,
	maxMembers: r.max_members ?? null,
	availableUntil: r.available_until ?? null,
	giftDays: r.gift_days ?? 0,
	perSeat: !!r.per_seat,
	active: !!r.active,
	syncError: r.sync_error,
});

/** Cleans an entitlement list: trimmed, lowercase-insensitive duplicates removed, no blanks. */
export function normalizeEntitlements(list: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of list) {
		const e = raw.trim();
		if (e && e.length <= 64 && !out.includes(e)) out.push(e);
	}
	return out;
}

// ─────────────────────────────── plans ───────────────────────────────

export async function listPlans(db: Db, opts: { includeArchived?: boolean } = {}): Promise<MembershipPlan[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_plans ${opts.includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY sort_order, created_at`)
		.all<PlanRow>();
	return results.map(toPlan);
}

export async function getPlan(db: Db, id: string): Promise<MembershipPlan | null> {
	await ensureSchema(db);
	const r = await db.prepare(`SELECT * FROM mbr_plans WHERE id = ?`).bind(id).first<PlanRow>();
	return r ? toPlan(r) : null;
}

export interface PlanInput {
	id: string;
	name: string;
	description?: string | null;
	entitlements?: readonly string[];
	visible?: boolean;
	sortOrder?: number;
}

export type SavePlanResult = { ok: true; plan: MembershipPlan; created: boolean } | { ok: false; reason: "invalid_id" | "invalid_name" };

/**
 * Creates or updates a plan. Changing a plan's entitlements updates every
 * member who holds it. The free plan can be renamed and given entitlements
 * (everyone gets them), but stays unpaid.
 */
export async function savePlan(db: Db, input: PlanInput, now = Date.now()): Promise<SavePlanResult> {
	await ensureSchema(db);
	const id = input.id.trim().toLowerCase();
	if (!SLUG.test(id)) return { ok: false, reason: "invalid_id" };
	const name = input.name.trim();
	if (!name || name.length > 80) return { ok: false, reason: "invalid_name" };
	const existing = await getPlan(db, id);
	const entitlements = normalizeEntitlements(input.entitlements ?? existing?.entitlements ?? []);
	await db
		.prepare(
			`INSERT INTO mbr_plans (id, name, description, entitlements, paid, visible, sort_order, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
			 ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
			   entitlements = excluded.entitlements, visible = excluded.visible, sort_order = excluded.sort_order,
			   updated_at = excluded.updated_at`,
		)
		.bind(
			id,
			name,
			input.description?.trim() || null,
			JSON.stringify(entitlements),
			id === FREE_PLAN ? 0 : 1,
			input.visible === undefined ? (existing?.visible ?? true) ? 1 : 0 : input.visible ? 1 : 0,
			input.sortOrder ?? existing?.sortOrder ?? 100,
			now,
		)
		.run();
	if (existing && JSON.stringify(existing.entitlements) !== JSON.stringify(entitlements)) await rebuildEntitlements(db, now);
	const plan = (await getPlan(db, id))!;
	return { ok: true, plan, created: !existing };
}

/** Hides a plan from new purchases. Members who hold it keep it. The free plan can't be archived. */
export async function archivePlan(db: Db, id: string, archived = true, now = Date.now()): Promise<boolean> {
	await ensureSchema(db);
	if (id === FREE_PLAN) return false;
	const r = (await db
		.prepare(`UPDATE mbr_plans SET archived_at = ?, updated_at = ? WHERE id = ? RETURNING id`)
		.bind(archived ? now : null, now, id)
		.all()).results;
	return r.length > 0;
}

/** Records the Stripe Product a plan is sold as. */
export async function setPlanProduct(db: Db, id: string, productId: string, now = Date.now()): Promise<void> {
	await db.prepare(`UPDATE mbr_plans SET stripe_product_id = ?, updated_at = ? WHERE id = ?`).bind(productId, now, id).run();
}

/** The paid plan used when access comes from somewhere unmapped (an old price, a 0.2 grant): "pro", else the first paid plan. */
export async function fallbackPaidPlan(db: Db): Promise<string> {
	const r = await db
		.prepare(`SELECT id FROM mbr_plans WHERE paid = 1 ORDER BY (id = 'pro') DESC, archived_at IS NOT NULL, sort_order, created_at LIMIT 1`)
		.first<{ id: string }>();
	return r?.id ?? "pro";
}

// ─────────────────────────────── prices ───────────────────────────────

export async function listPrices(db: Db, opts: { planId?: string; activeOnly?: boolean } = {}): Promise<PlanPrice[]> {
	await ensureSchema(db);
	const where: string[] = [];
	const args: unknown[] = [];
	if (opts.planId) {
		where.push("plan_id = ?");
		args.push(opts.planId);
	}
	if (opts.activeOnly) where.push("active = 1");
	const { results } = await db
		.prepare(`SELECT * FROM mbr_prices ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY plan_id, kind, interval, amount`)
		.bind(...args)
		.all<PriceRow>();
	return results.map(toPrice);
}

export async function getPrice(db: Db, by: { id?: string; lookupKey?: string; stripePriceId?: string }): Promise<PlanPrice | null> {
	await ensureSchema(db);
	const [col, val] = by.id ? ["id", by.id] : by.lookupKey ? ["lookup_key", by.lookupKey] : ["stripe_price_id", by.stripePriceId];
	if (!val) return null;
	const r = await db.prepare(`SELECT * FROM mbr_prices WHERE ${col} = ?`).bind(val).first<PriceRow>();
	return r ? toPrice(r) : null;
}

export interface PriceInput {
	planId: string;
	lookupKey: string;
	kind: "recurring" | "one_time";
	amount: number;
	currency: string;
	interval?: "month" | "year" | null;
	intervalCount?: number;
	trialDays?: number;
	grantsEarlyAccess?: boolean;
	maxMembers?: number | null;
	availableUntil?: number | null;
	giftDays?: number;
	perSeat?: boolean;
	stripePriceId?: string | null;
	active?: boolean;
}

export type SavePriceResult =
	| { ok: true; price: PlanPrice }
	| { ok: false; reason: "unknown_plan" | "free_plan" | "invalid_lookup_key" | "invalid_amount" | "invalid_currency" | "invalid_interval" | "lookup_key_taken" };

/** Validates a price; shared by the database write and the Stripe sync. */
export function validatePrice(input: PriceInput): Exclude<SavePriceResult, { ok: true }> | null {
	if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(input.lookupKey)) return { ok: false, reason: "invalid_lookup_key" };
	if (!Number.isInteger(input.amount) || input.amount < 0 || input.amount > 99_999_999) return { ok: false, reason: "invalid_amount" };
	if (!/^[a-z]{3}$/i.test(input.currency)) return { ok: false, reason: "invalid_currency" };
	if (input.kind === "recurring" && input.interval !== "month" && input.interval !== "year") return { ok: false, reason: "invalid_interval" };
	return null;
}

/** Writes a price record (no Stripe call; see ./catalog for the synced version). */
export async function savePriceRecord(db: Db, input: PriceInput, now = Date.now()): Promise<SavePriceResult> {
	await ensureSchema(db);
	const plan = await getPlan(db, input.planId);
	if (!plan) return { ok: false, reason: "unknown_plan" };
	if (!plan.paid) return { ok: false, reason: "free_plan" };
	const invalid = validatePrice(input);
	if (invalid) return invalid;
	const existing = await getPrice(db, { lookupKey: input.lookupKey });
	if (existing && existing.planId !== input.planId) return { ok: false, reason: "lookup_key_taken" };
	const recurring = input.kind === "recurring";
	await db
		.prepare(
			`INSERT INTO mbr_prices (id, plan_id, lookup_key, stripe_price_id, kind, amount, currency, interval, interval_count,
				trial_days, grants_early_access, active, created_at, updated_at, max_members, available_until, gift_days, per_seat)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?15, ?16, ?17)
			 ON CONFLICT (lookup_key) DO UPDATE SET stripe_price_id = COALESCE(excluded.stripe_price_id, mbr_prices.stripe_price_id),
			   kind = excluded.kind, amount = excluded.amount, currency = excluded.currency, interval = excluded.interval,
			   interval_count = excluded.interval_count, trial_days = excluded.trial_days,
			   grants_early_access = excluded.grants_early_access, active = excluded.active, sync_error = NULL,
			   max_members = excluded.max_members, available_until = excluded.available_until,
			   gift_days = excluded.gift_days, per_seat = excluded.per_seat, updated_at = excluded.updated_at`,
		)
		.bind(
			existing?.id ?? `price_${crypto.randomUUID()}`,
			input.planId,
			input.lookupKey,
			input.stripePriceId ?? null,
			input.kind,
			input.amount,
			input.currency.toLowerCase(),
			recurring ? input.interval : null,
			recurring ? Math.max(1, Math.floor(input.intervalCount ?? 1)) : 1,
			recurring ? Math.max(0, Math.floor(input.trialDays ?? 0)) : 0,
			!recurring && input.grantsEarlyAccess && !input.giftDays ? 1 : 0,
			input.active === false ? 0 : 1,
			now,
			input.maxMembers && input.maxMembers > 0 ? Math.floor(input.maxMembers) : null,
			input.availableUntil ?? null,
			!recurring && input.giftDays && input.giftDays > 0 ? Math.floor(input.giftDays) : 0,
			recurring && input.perSeat ? 1 : 0,
		)
		.run();
	return { ok: true, price: (await getPrice(db, { lookupKey: input.lookupKey }))! };
}

export async function setPriceActive(db: Db, lookupKey: string, active: boolean, now = Date.now()): Promise<void> {
	await db.prepare(`UPDATE mbr_prices SET active = ?, updated_at = ? WHERE lookup_key = ?`).bind(active ? 1 : 0, now, lookupKey).run();
}

export async function setPriceSyncError(db: Db, lookupKey: string, error: string | null): Promise<void> {
	await db.prepare(`UPDATE mbr_prices SET sync_error = ? WHERE lookup_key = ?`).bind(error, lookupKey).run();
}

// ─────────────────────────────── access ───────────────────────────────

/** True when the member has the entitlement. 0.2 members (no entitlements loaded) count "pro" from their plan. */
export function can(member: { plan?: string; entitlements?: readonly string[] } | null | undefined, entitlement: string): boolean {
	if (!member) return false;
	if (member.entitlements?.includes(entitlement)) return true;
	return entitlement === "pro" && member.plan === "pro" && !member.entitlements;
}

/**
 * Works out which paid plans a member holds right now and what they grant.
 * Read-only; `recomputePlan` (./launch) stores the result.
 */
export async function resolveAccess(
	db: Db,
	memberId: string,
	opts: { proStatuses?: readonly string[]; now?: number } = {},
): Promise<MemberAccess> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const pro = statusList(opts.proStatuses ?? DEFAULT_PRO_STATUSES);
	const fallback = await fallbackPaidPlan(db);
	const [early, subs, grants, teams] = await Promise.all([
		db
			.prepare(
				`SELECT (SELECT p.plan_id FROM mbr_prices p WHERE p.grants_early_access = 1 ORDER BY p.active DESC, p.created_at LIMIT 1) AS plan_id
				 FROM mbr_billing b WHERE b.member_id = ?1 AND b.early_access_at IS NOT NULL AND b.early_access_revoked_at IS NULL
				   AND (b.grace_ends_at IS NULL OR b.grace_ends_at > ?2)`,
			)
			.bind(memberId, t)
			.first<{ plan_id: string | null }>(),
		db
			.prepare(
				`SELECT COALESCE(
					(SELECT p.plan_id FROM mbr_prices p WHERE p.stripe_price_id = s.price_id),
					(SELECT p.plan_id FROM mbr_prices p WHERE p.lookup_key = s.lookup_key)) AS plan_id
				 FROM mbr_subscriptions s WHERE s.member_id = ? AND s.status IN (${pro})`,
			)
			.bind(memberId)
			.all<{ plan_id: string | null }>(),
		db
			.prepare(
				`SELECT gp.plan_id FROM mbr_grants g LEFT JOIN mbr_grant_plans gp ON gp.grant_id = g.id
				 WHERE g.member_id = ? AND g.revoked_at IS NULL AND g.ends_at > ?`,
			)
			.bind(memberId, t)
			.all<{ plan_id: string | null }>(),
		// Seats on an active team whose subscription is live (or that has none: a comp team)
		db
			.prepare(
				`SELECT t.plan_id FROM mbr_team_members tm JOIN mbr_teams t ON t.id = tm.team_id
				 WHERE tm.member_id = ? AND tm.status = 'active' AND t.status = 'active'
				   AND (t.subscription_id IS NULL OR EXISTS (SELECT 1 FROM mbr_subscriptions s WHERE s.id = t.subscription_id AND s.status IN (${pro})))`,
			)
			.bind(memberId)
			.all<{ plan_id: string }>(),
	]);
	// A grant counts from the moment it's given until it ends, stacked ones
	// included; grants created by 0.2 have no plan row and mean the fallback plan.
	const held = new Set<string>();
	if (early) held.add(early.plan_id ?? fallback);
	for (const s of subs.results) held.add(s.plan_id ?? fallback);
	for (const g of grants.results) held.add(g.plan_id ?? fallback);
	for (const tm of teams.results) held.add(tm.plan_id);
	held.delete(FREE_PLAN);
	const plans = [...held].sort();
	return { plans, entitlements: await entitlementsFor(db, plans), paid: plans.length > 0 };
}

async function entitlementsFor(db: Db, plans: readonly string[]): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id, entitlements FROM mbr_plans WHERE id = 'free' OR id IN (${plans.map(() => "?").join(", ") || "NULL"})`)
		.bind(...plans)
		.all<{ id: string; entitlements: string }>();
	return normalizeEntitlements(results.flatMap((r) => parseList(r.entitlements))).sort();
}

/** The cached access for a member (what `getSession` returns). */
export async function cachedAccess(db: Db, memberId: string): Promise<MemberAccess> {
	await ensureSchema(db);
	const r = await db.prepare(`SELECT plans, entitlements FROM mbr_member_access WHERE member_id = ?`).bind(memberId).first<{ plans: string; entitlements: string }>();
	const plans = parseList(r?.plans);
	return { plans, entitlements: r ? parseList(r.entitlements) : await entitlementsFor(db, []), paid: plans.length > 0 };
}

/** The statement that writes a member's access cache row (run it in your batch). */
export function storeAccess(db: Db, memberId: string, access: MemberAccess, now = Date.now()): DbStatement {
	return db
		.prepare(
			`INSERT INTO mbr_member_access (member_id, plans, entitlements, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (member_id) DO UPDATE SET plans = excluded.plans, entitlements = excluded.entitlements, updated_at = excluded.updated_at`,
		)
		.bind(memberId, JSON.stringify(access.plans), JSON.stringify(access.entitlements), now);
}

/**
 * Recomputes every member's cached entitlements from the plans they hold,
 * after a plan's entitlements change. Plans held don't change, so no billing
 * state is read.
 */
export async function rebuildEntitlements(db: Db, now = Date.now()): Promise<number> {
	await ensureSchema(db);
	const plans = new Map((await listPlans(db, { includeArchived: true })).map((p) => [p.id, p.entitlements]));
	const base = plans.get(FREE_PLAN) ?? [];
	let updated = 0;
	let after = "";
	for (;;) {
		const { results } = await db
			.prepare(`SELECT member_id, plans, entitlements FROM mbr_member_access WHERE member_id > ? ORDER BY member_id LIMIT 500`)
			.bind(after)
			.all<{ member_id: string; plans: string; entitlements: string }>();
		if (!results.length) break;
		const writes = [];
		for (const r of results) {
			const ents = normalizeEntitlements([...base, ...parseList(r.plans).flatMap((p) => plans.get(p) ?? [])]).sort();
			const json = JSON.stringify(ents);
			if (json !== r.entitlements) {
				writes.push(db.prepare(`UPDATE mbr_member_access SET entitlements = ?, updated_at = ? WHERE member_id = ?`).bind(json, now, r.member_id));
			}
		}
		if (writes.length) await db.batch(writes);
		updated += writes.length;
		after = results[results.length - 1].member_id;
	}
	return updated;
}
