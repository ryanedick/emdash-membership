/**
 * Teams: one payer, many seats.
 *
 * A team price is a recurring price marked per-seat. Checkout buys N seats
 * (the subscription quantity) and creates a team owned by the buyer, who is
 * its first admin and takes a seat. Admins invite people by email or share
 * the team's join link; anyone with an email at the team's join domain can
 * join on their own. Every active seat holder gets the team's plan while the
 * subscription is live. Staff can also make a team with no subscription
 * (a comp team), e.g. for a partner.
 */
import { randomToken } from "./crypto.ts";
import { type Db, ensureSchema } from "./db.ts";
import { emitEvent } from "./events.ts";
import { recomputePlan } from "./launch.ts";
import { enqueueEmail } from "./lifecycle.ts";
import { type Member, normalizeEmail } from "./memberships.ts";
import { getPlan } from "./plans.ts";

export type TeamStatus = "pending" | "active" | "inactive";

export interface Team {
	id: string;
	name: string;
	ownerMemberId: string;
	planId: string;
	seats: number;
	subscriptionId: string | null;
	joinDomain: string | null;
	inviteToken: string;
	status: TeamStatus;
	createdAt: number;
}

export interface TeamSeat {
	email: string;
	memberId: string | null;
	role: "admin" | "member";
	status: "invited" | "active" | "removed";
	invitedAt: number;
	joinedAt: number | null;
}

interface TeamRow {
	id: string;
	name: string;
	owner_member_id: string;
	plan_id: string;
	seats: number;
	subscription_id: string | null;
	join_domain: string | null;
	invite_token: string;
	status: string;
	created_at: number;
}

const toTeam = (r: TeamRow): Team => ({
	id: r.id,
	name: r.name,
	ownerMemberId: r.owner_member_id,
	planId: r.plan_id,
	seats: r.seats,
	subscriptionId: r.subscription_id,
	joinDomain: r.join_domain,
	inviteToken: r.invite_token,
	status: (["pending", "active", "inactive"].includes(r.status) ? r.status : "inactive") as TeamStatus,
	createdAt: r.created_at,
});

export async function getTeam(db: Db, by: { id?: string; token?: string; subscriptionId?: string; sessionId?: string }): Promise<Team | null> {
	await ensureSchema(db);
	const [col, val] = by.id
		? ["id", by.id]
		: by.token
			? ["invite_token", by.token]
			: by.subscriptionId
				? ["subscription_id", by.subscriptionId]
				: ["checkout_session_id", by.sessionId];
	if (!val) return null;
	const r = await db.prepare(`SELECT * FROM mbr_teams WHERE ${col} = ?`).bind(val).first<TeamRow>();
	return r ? toTeam(r) : null;
}

export async function listTeams(db: Db, opts: { memberId?: string } = {}): Promise<Team[]> {
	await ensureSchema(db);
	const { results } = opts.memberId
		? await db
				.prepare(`SELECT t.* FROM mbr_teams t JOIN mbr_team_members tm ON tm.team_id = t.id WHERE tm.member_id = ? AND tm.status = 'active' ORDER BY t.created_at`)
				.bind(opts.memberId)
				.all<TeamRow>()
		: await db.prepare(`SELECT * FROM mbr_teams WHERE status <> 'pending' ORDER BY created_at DESC`).all<TeamRow>();
	return results.map(toTeam);
}

export async function listSeats(db: Db, teamId: string): Promise<TeamSeat[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_team_members WHERE team_id = ? AND status <> 'removed' ORDER BY role = 'admin' DESC, invited_at`)
		.bind(teamId)
		.all<{ email: string; member_id: string | null; role: string; status: string; invited_at: number; joined_at: number | null }>();
	return results.map((r) => ({
		email: r.email,
		memberId: r.member_id,
		role: r.role === "admin" ? "admin" : "member",
		status: r.status as TeamSeat["status"],
		invitedAt: r.invited_at,
		joinedAt: r.joined_at,
	}));
}

async function seatsUsed(db: Db, teamId: string): Promise<number> {
	const r = await db.prepare(`SELECT COUNT(*) AS n FROM mbr_team_members WHERE team_id = ? AND status IN ('active', 'invited')`).bind(teamId).first<{ n: number }>();
	return Number(r?.n ?? 0);
}

export async function isTeamAdmin(db: Db, teamId: string, memberId: string): Promise<boolean> {
	return !!(await db.prepare(`SELECT 1 FROM mbr_team_members WHERE team_id = ? AND member_id = ? AND role = 'admin' AND status = 'active'`).bind(teamId, memberId).first());
}

function cleanDomain(d: string | null | undefined): string | null {
	const v = d?.trim().toLowerCase().replace(/^@/, "") || null;
	return v && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? v : null;
}

/** Step one of a team checkout: a pending team for the buyer. */
export async function createPendingTeam(db: Db, input: { owner: Pick<Member, "id" | "email">; planId: string; seats: number; name: string; now?: number }): Promise<Team> {
	await ensureSchema(db);
	const t = input.now ?? Date.now();
	const id = `team_${crypto.randomUUID()}`;
	await db
		.prepare(`INSERT INTO mbr_teams (id, name, owner_member_id, plan_id, seats, invite_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
		.bind(id, input.name.trim().slice(0, 80) || "My team", input.owner.id, input.planId, Math.max(1, Math.floor(input.seats)), randomToken(18), t, t)
		.run();
	return (await getTeam(db, { id }))!;
}

export async function attachTeamCheckout(db: Db, teamId: string, sessionId: string): Promise<void> {
	await db.prepare(`UPDATE mbr_teams SET checkout_session_id = ? WHERE id = ?`).bind(sessionId, teamId).run();
}

/** Payment confirmed: activate the team, link its subscription, seat the owner as admin. Idempotent. */
export async function activateTeam(db: Db, teamId: string, subscriptionId: string | null, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<Team | null> {
	const t = opts.now ?? Date.now();
	const team = await getTeam(db, { id: teamId });
	if (!team) return null;
	const owner = await db.prepare(`SELECT email FROM mbr_members WHERE id = ?`).bind(team.ownerMemberId).first<{ email: string }>();
	const first = team.status === "pending";
	await db.batch([
		db.prepare(`UPDATE mbr_teams SET status = 'active', subscription_id = COALESCE(?, subscription_id), updated_at = ? WHERE id = ?`).bind(subscriptionId, t, teamId),
		...(owner
			? [
					db
						.prepare(
							`INSERT INTO mbr_team_members (team_id, email, member_id, role, status, invited_at, joined_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?)
							 ON CONFLICT (team_id, email) DO NOTHING`,
						)
						.bind(teamId, owner.email, team.ownerMemberId, t, t),
				]
			: []),
	]);
	if (first) await emitEvent(db, "team.created", team.ownerMemberId, { teamId, plan: team.planId, seats: team.seats }, t);
	await refreshTeamAccess(db, teamId, opts);
	return getTeam(db, { id: teamId });
}

/** Recomputes access for everyone seated on a team (after its subscription or membership changes). */
export async function refreshTeamAccess(db: Db, teamId: string, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<void> {
	const { results } = await db.prepare(`SELECT member_id FROM mbr_team_members WHERE team_id = ? AND member_id IS NOT NULL`).bind(teamId).all<{ member_id: string }>();
	for (const r of results) await recomputePlan(db, r.member_id, opts);
}

/** Staff-made team with no subscription. */
export async function createCompTeam(db: Db, input: { owner: Pick<Member, "id" | "email">; planId: string; seats: number; name: string; joinDomain?: string | null; now?: number }): Promise<Team | null> {
	const plan = await getPlan(db, input.planId);
	if (!plan?.paid) return null;
	const team = await createPendingTeam(db, input);
	if (input.joinDomain) await setJoinDomain(db, team.id, input.joinDomain);
	return activateTeam(db, team.id, null, { now: input.now });
}

export type SeatResult = { ok: true } | { ok: false; reason: "no_team" | "inactive" | "no_seats" | "invalid_email" | "already_member" | "not_invited" };

/** Invites an email address (takes a seat until they join or are removed) and emails them the join link. */
export async function inviteToTeam(db: Db, teamId: string, rawEmail: string, opts: { role?: "admin" | "member"; now?: number } = {}): Promise<SeatResult> {
	const t = opts.now ?? Date.now();
	const team = await getTeam(db, { id: teamId });
	if (!team) return { ok: false, reason: "no_team" };
	if (team.status !== "active") return { ok: false, reason: "inactive" };
	const email = normalizeEmail(rawEmail);
	if (!email) return { ok: false, reason: "invalid_email" };
	const existing = await db.prepare(`SELECT status FROM mbr_team_members WHERE team_id = ? AND email = ?`).bind(teamId, email).first<{ status: string }>();
	if (existing && existing.status !== "removed") return { ok: false, reason: "already_member" };
	if ((await seatsUsed(db, teamId)) >= team.seats) return { ok: false, reason: "no_seats" };
	await db
		.prepare(
			`INSERT INTO mbr_team_members (team_id, email, member_id, role, status, invited_at) VALUES (?, ?, NULL, ?, 'invited', ?)
			 ON CONFLICT (team_id, email) DO UPDATE SET status = 'invited', role = excluded.role, invited_at = excluded.invited_at, member_id = NULL, joined_at = NULL`,
		)
		.bind(teamId, email, opts.role ?? "member", t)
		.run();
	const plan = await getPlan(db, team.planId);
	await enqueueEmail(
		db,
		{ kind: "team_invite", to: email, dedupeKey: `team-invite:${teamId}:${email}:${t}`, data: { teamName: team.name, planName: plan?.name ?? "Pro", path: `/team/join?token=${team.inviteToken}` } },
		t,
	);
	return { ok: true };
}

/**
 * A signed-in member takes a seat via the team's join link: allowed when
 * they were invited, their email matches the join domain, or a seat is free.
 */
export async function joinTeam(db: Db, token: string, member: Pick<Member, "id" | "email">, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<SeatResult & { team?: Team }> {
	const t = opts.now ?? Date.now();
	const team = await getTeam(db, { token });
	if (!team) return { ok: false, reason: "no_team" };
	if (team.status !== "active") return { ok: false, reason: "inactive" };
	const seat = await db.prepare(`SELECT status FROM mbr_team_members WHERE team_id = ? AND email = ?`).bind(team.id, member.email).first<{ status: string }>();
	if (seat?.status === "active") return { ok: true, team };
	if (seat?.status !== "invited" && (await seatsUsed(db, team.id)) >= team.seats) return { ok: false, reason: "no_seats" };
	await db
		.prepare(
			`INSERT INTO mbr_team_members (team_id, email, member_id, role, status, invited_at, joined_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)
			 ON CONFLICT (team_id, email) DO UPDATE SET member_id = excluded.member_id, status = 'active', joined_at = excluded.joined_at`,
		)
		.bind(team.id, member.email, member.id, t, t)
		.run();
	await recomputePlan(db, member.id, { ...opts, now: t });
	await emitEvent(db, "team.member_joined", member.id, { teamId: team.id, plan: team.planId }, t);
	return { ok: true, team };
}

/** Seats a member automatically on every active team whose join domain matches their email (call it after sign-in). */
export async function autoJoinTeams(db: Db, member: Pick<Member, "id" | "email">, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<string[]> {
	await ensureSchema(db);
	const domain = member.email.split("@")[1]?.toLowerCase();
	if (!domain) return [];
	const { results } = await db
		.prepare(
			`SELECT t.invite_token, t.id FROM mbr_teams t WHERE t.join_domain = ? AND t.status = 'active'
			 AND NOT EXISTS (SELECT 1 FROM mbr_team_members tm WHERE tm.team_id = t.id AND tm.email = ? AND tm.status IN ('active', 'removed'))`,
		)
		.bind(domain, member.email)
		.all<{ invite_token: string; id: string }>();
	const joined: string[] = [];
	for (const r of results) if ((await joinTeam(db, r.invite_token, member, opts)).ok) joined.push(r.id);
	return joined;
}

/** Frees a seat. The owner can't be removed. */
export async function removeFromTeam(db: Db, teamId: string, rawEmail: string, opts: { proStatuses?: readonly string[]; now?: number } = {}): Promise<boolean> {
	const team = await getTeam(db, { id: teamId });
	const email = normalizeEmail(rawEmail);
	if (!team || !email) return false;
	const seat = await db.prepare(`SELECT member_id FROM mbr_team_members WHERE team_id = ? AND email = ? AND status <> 'removed'`).bind(teamId, email).first<{ member_id: string | null }>();
	if (!seat || seat.member_id === team.ownerMemberId) return false;
	await db.prepare(`UPDATE mbr_team_members SET status = 'removed' WHERE team_id = ? AND email = ?`).bind(teamId, email).run();
	if (seat.member_id) {
		await recomputePlan(db, seat.member_id, opts);
		await emitEvent(db, "team.member_removed", seat.member_id, { teamId }, opts.now);
	}
	return true;
}

export async function setTeamRole(db: Db, teamId: string, email: string, role: "admin" | "member"): Promise<void> {
	await db.prepare(`UPDATE mbr_team_members SET role = ? WHERE team_id = ? AND email = ?`).bind(role, teamId, email.toLowerCase()).run();
}

export async function setJoinDomain(db: Db, teamId: string, domain: string | null): Promise<boolean> {
	const d = domain ? cleanDomain(domain) : null;
	if (domain && !d) return false;
	await db.prepare(`UPDATE mbr_teams SET join_domain = ? WHERE id = ?`).bind(d, teamId).run();
	return true;
}

export async function renameTeam(db: Db, teamId: string, name: string): Promise<void> {
	if (name.trim()) await db.prepare(`UPDATE mbr_teams SET name = ? WHERE id = ?`).bind(name.trim().slice(0, 80), teamId).run();
}

/** A fresh join link (the old one stops working). */
export async function rotateTeamLink(db: Db, teamId: string): Promise<void> {
	await db.prepare(`UPDATE mbr_teams SET invite_token = ? WHERE id = ?`).bind(randomToken(18), teamId).run();
}

/** Records a new seat count (after Stripe's quantity changed) and whether seats are over-used. */
export async function setTeamSeats(db: Db, teamId: string, seats: number, now = Date.now()): Promise<void> {
	await db.prepare(`UPDATE mbr_teams SET seats = ?, updated_at = ? WHERE id = ?`).bind(Math.max(1, Math.floor(seats)), now, teamId).run();
}

export async function seatsInUse(db: Db, teamId: string): Promise<number> {
	return seatsUsed(db, teamId);
}
