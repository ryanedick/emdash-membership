/**
 * Comp grants: time-limited Pro that doesn't come from Stripe, e.g. a referral
 * reward, a giveaway or a support gesture. Pure database logic, so it can run
 * from a request, a hook or a scheduled job.
 *
 * - Each grant has a caller-chosen `key` (unique). Granting the same key twice
 *   is a no-op, so a retried hook never gives the reward twice.
 * - Grants stack: a new grant starts when the member's last active grant ends.
 *   A grant counts toward Pro from the moment it's given until its end.
 * - The member row is created (on Free) if the email has never signed in, so a
 *   reward can be given before the person ever visits the site.
 * - `expireGrants()` moves members back to Free when their time runs out
 *   (unless something else, like a subscription, keeps them on Pro). Run it
 *   from a scheduled job.
 */
import { type Db, ensureSchema } from "./db.ts";
import { DEFAULT_PRO_STATUSES, recomputePlan } from "./launch.ts";
import { normalizeEmail } from "./memberships.ts";

const DAY = 24 * 60 * 60 * 1000;

export interface ProGrant {
	id: string;
	memberId: string;
	key: string;
	reason: string | null;
	startsAt: number;
	endsAt: number;
	revokedAt: number | null;
	createdAt: number;
}

export interface GrantProInput {
	email: string;
	/** Length of the grant in days (fractions allowed). */
	days: number;
	/** Idempotency key, e.g. "referral:<subscriber id>:3". Unique across all grants. */
	key: string;
	/** Shown in admin/exports, e.g. "Referral reward: 3 referrals". */
	reason?: string;
	proStatuses?: readonly string[];
	now?: number;
}

export type GrantProResult =
	| { ok: true; created: boolean; grant: ProGrant; plan: "free" | "pro" }
	| { ok: false; reason: "invalid_email" | "invalid_days" };

interface GrantRow {
	id: string;
	member_id: string;
	source_key: string;
	reason: string | null;
	starts_at: number;
	ends_at: number;
	revoked_at: number | null;
	created_at: number;
}

function toGrant(r: GrantRow): ProGrant {
	return {
		id: r.id,
		memberId: r.member_id,
		key: r.source_key,
		reason: r.reason,
		startsAt: r.starts_at,
		endsAt: r.ends_at,
		revokedAt: r.revoked_at,
		createdAt: r.created_at,
	};
}

async function grantByKey(db: Db, key: string): Promise<ProGrant | null> {
	const r = await db.prepare(`SELECT * FROM mbr_grants WHERE source_key = ?`).bind(key).first<GrantRow>();
	return r ? toGrant(r) : null;
}

/** Gives `email` Pro for `days`, once per `key`. */
export async function grantProTime(db: Db, input: GrantProInput): Promise<GrantProResult> {
	const email = normalizeEmail(input.email);
	if (!email) return { ok: false, reason: "invalid_email" };
	if (!Number.isFinite(input.days) || input.days <= 0 || input.days > 3660) return { ok: false, reason: "invalid_days" };
	if (!input.key || input.key.length > 200) throw new Error("memberships: grant key is required (max 200 chars)");
	await ensureSchema(db);
	const t = input.now ?? Date.now();
	const opts = { proStatuses: input.proStatuses ?? DEFAULT_PRO_STATUSES, now: t };

	const existing = await grantByKey(db, input.key);
	if (existing) return { ok: true, created: false, grant: existing, plan: await recomputePlan(db, existing.memberId, opts) };

	const member = await db
		.prepare(
			`INSERT INTO mbr_members (id, email, plan, created_at) VALUES (?, ?, 'free', ?)
			 ON CONFLICT (email) DO UPDATE SET email = excluded.email
			 RETURNING id`,
		)
		.bind(`mbr_${crypto.randomUUID()}`, email, t)
		.first<{ id: string }>();
	if (!member) throw new Error("memberships: member upsert returned no row");

	// Stack after the member's latest active grant, so two rewards make two months.
	const last = await db
		.prepare(`SELECT MAX(ends_at) AS ends_at FROM mbr_grants WHERE member_id = ? AND revoked_at IS NULL AND ends_at > ?`)
		.bind(member.id, t)
		.first<{ ends_at: number | null }>();
	const startsAt = Math.max(t, last?.ends_at ?? 0);
	const endsAt = startsAt + Math.round(input.days * DAY);

	// ON CONFLICT DO NOTHING: two concurrent calls with one key create one grant.
	const inserted = await db
		.prepare(
			`INSERT INTO mbr_grants (id, member_id, source_key, reason, starts_at, ends_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_key) DO NOTHING RETURNING id`,
		)
		.bind(`grt_${crypto.randomUUID()}`, member.id, input.key, input.reason?.slice(0, 300) ?? null, startsAt, endsAt, t)
		.first<{ id: string }>();
	const grant = (await grantByKey(db, input.key))!;
	return { ok: true, created: !!inserted, grant, plan: await recomputePlan(db, grant.memberId, opts) };
}

/** Ends a grant now (e.g. the referrals turned out to be fake). */
export async function revokeGrant(
	db: Db,
	key: string,
	opts: { proStatuses?: readonly string[]; now?: number } = {},
): Promise<ProGrant | null> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	await db.prepare(`UPDATE mbr_grants SET revoked_at = ? WHERE source_key = ? AND revoked_at IS NULL`).bind(t, key).run();
	const grant = await grantByKey(db, key);
	if (grant) await recomputePlan(db, grant.memberId, { ...opts, now: t });
	return grant;
}

/** A member's grants, newest first. */
export async function listGrants(db: Db, memberId: string): Promise<ProGrant[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_grants WHERE member_id = ? ORDER BY starts_at DESC`)
		.bind(memberId)
		.all<GrantRow>();
	return results.map(toGrant);
}

/** When the member's comp time runs out (stacked grants included), or null if they have none. */
export async function compEndsAt(db: Db, memberId: string, now = Date.now()): Promise<number | null> {
	await ensureSchema(db);
	const r = await db
		.prepare(`SELECT MAX(ends_at) AS ends_at FROM mbr_grants WHERE member_id = ? AND revoked_at IS NULL AND ends_at > ?`)
		.bind(memberId, now)
		.first<{ ends_at: number | null }>();
	return r?.ends_at ?? null;
}

/**
 * Settles grants whose time is up: recomputes each member's plan (dropping
 * them to Free unless something else keeps them on Pro) and marks the grant
 * settled so it isn't looked at again. Returns the ids of members who dropped
 * to Free.
 */
export async function expireGrants(
	db: Db,
	opts: { proStatuses?: readonly string[]; now?: number; limit?: number } = {},
): Promise<string[]> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const { results } = await db
		.prepare(`SELECT id, member_id FROM mbr_grants WHERE settled_at IS NULL AND ends_at <= ? ORDER BY ends_at LIMIT ?`)
		.bind(t, opts.limit ?? 200)
		.all<{ id: string; member_id: string }>();
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const r of results) {
		if (!seen.has(r.member_id)) {
			seen.add(r.member_id);
			if ((await recomputePlan(db, r.member_id, { ...opts, now: t })) === "free") dropped.push(r.member_id);
		}
		await db.prepare(`UPDATE mbr_grants SET settled_at = ? WHERE id = ?`).bind(t, r.id).run();
	}
	return dropped;
}
