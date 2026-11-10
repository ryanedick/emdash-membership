import { randomToken, sha256Hex } from "./crypto.ts";
import { type Db, ensureSchema } from "./db.ts";
import type { LoginEmailSender } from "./email.ts";

export type Plan = "free" | "pro";

export interface Member {
	id: string;
	email: string;
	plan: Plan;
	createdAt: number;
	lastLoginAt: number | null;
}

export interface MembershipsConfig {
	db: Db;
	sender: LoginEmailSender;
	/** Path of the page that confirms a link, e.g. "/login/verify". The token is appended as ?token= */
	verifyPath?: string;
	/** Default 15 minutes */
	linkTtlMinutes?: number;
	/** Default 30 days. Sessions slide: they renew when less than half remains. */
	sessionTtlDays?: number;
	/** Links one address may request per hour. Default 5. */
	maxLinksPerEmailPerHour?: number;
	/** Links one IP may request per hour. Default 20. */
	maxLinksPerIpPerHour?: number;
	now?: () => number;
}

export type RequestLinkResult =
	| { ok: true }
	| { ok: false; reason: "invalid_email" | "rate_limited" | "send_failed" };

export type ConsumeLinkResult =
	| { ok: true; member: Member; session: NewSession; next: string | null }
	| { ok: false; reason: "invalid_or_expired" };

export interface NewSession {
	/** Put this in the cookie. Only its hash is stored. */
	token: string;
	expiresAt: number;
}

export interface ActiveSession {
	member: Member;
	expiresAt: number;
	/** Set when the session was extended; re-issue the cookie with this expiry */
	renewed: boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	return EMAIL.test(email) && email.length <= 254 ? email : null;
}

/**
 * Only same-site absolute paths are allowed as post-login destinations,
 * which rules out open redirects such as "//evil.com" or "/\evil.com".
 */
export function safeNextPath(raw: string | null | undefined): string | null {
	if (!raw || raw.length > 512) return null;
	if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
	if (/[\u0000-\u001f]/.test(raw)) return null;
	return raw;
}

interface MemberRow {
	id: string;
	email: string;
	plan: string;
	created_at: number;
	last_login_at: number | null;
}

function toMember(r: MemberRow): Member {
	return {
		id: r.id,
		email: r.email,
		plan: r.plan === "pro" ? "pro" : "free",
		createdAt: r.created_at,
		lastLoginAt: r.last_login_at,
	};
}

export function createMemberships(config: MembershipsConfig) {
	const db = config.db;
	const now = config.now ?? Date.now;
	const verifyPath = config.verifyPath ?? "/login/verify";
	const linkTtl = (config.linkTtlMinutes ?? 15) * 60 * 1000;
	const sessionTtl = (config.sessionTtlDays ?? 30) * DAY;
	const perEmail = config.maxLinksPerEmailPerHour ?? 5;
	const perIp = config.maxLinksPerIpPerHour ?? 20;

	async function createSession(memberId: string, userAgent?: string | null): Promise<NewSession> {
		const token = randomToken();
		const t = now();
		const expiresAt = t + sessionTtl;
		await db.batch([
			db
				.prepare(
					`INSERT INTO mbr_sessions (token_hash, member_id, created_at, expires_at, last_seen_at, user_agent)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.bind(await sha256Hex(token), memberId, t, expiresAt, t, userAgent?.slice(0, 200) ?? null),
			// Housekeeping: drop sessions that expired more than a day ago
			db.prepare(`DELETE FROM mbr_sessions WHERE expires_at < ?`).bind(t - DAY),
		]);
		return { token, expiresAt };
	}

	return {
		/**
		 * Emails a one-time sign-in link. Always answer the visitor with the same
		 * message whatever happens here, so the form can't be used to probe addresses.
		 */
		async requestLoginLink(input: {
			email: string;
			/** Site origin, e.g. "https://example.com" */
			origin: string;
			next?: string | null;
			ip?: string | null;
		}): Promise<RequestLinkResult> {
			const email = normalizeEmail(input.email);
			if (!email) return { ok: false, reason: "invalid_email" };
			await ensureSchema(db);

			const t = now();
			const since = t - HOUR;
			const byEmail = await db
				.prepare(`SELECT COUNT(*) AS n FROM mbr_login_tokens WHERE email = ? AND created_at > ?`)
				.bind(email, since)
				.first<{ n: number }>();
			if ((byEmail?.n ?? 0) >= perEmail) return { ok: false, reason: "rate_limited" };
			if (input.ip) {
				const byIp = await db
					.prepare(`SELECT COUNT(*) AS n FROM mbr_login_tokens WHERE ip = ? AND created_at > ?`)
					.bind(input.ip, since)
					.first<{ n: number }>();
				if ((byIp?.n ?? 0) >= perIp) return { ok: false, reason: "rate_limited" };
			}

			const token = randomToken();
			await db.batch([
				db
					.prepare(
						`INSERT INTO mbr_login_tokens (token_hash, email, next_path, ip, created_at, expires_at)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.bind(await sha256Hex(token), email, safeNextPath(input.next), input.ip ?? null, t, t + linkTtl),
				// Housekeeping: keep a day of history for rate limiting, drop the rest
				db.prepare(`DELETE FROM mbr_login_tokens WHERE created_at < ?`).bind(t - DAY),
			]);

			const url = new URL(verifyPath, input.origin);
			url.searchParams.set("token", token);
			try {
				await config.sender.send({ to: email, url: url.toString(), expiresInMinutes: linkTtl / 60000 });
			} catch (err) {
				console.error("[memberships] sending sign-in link failed", err);
				return { ok: false, reason: "send_failed" };
			}
			return { ok: true };
		},

		/**
		 * Checks a link without using it up. The confirm page calls this on GET, so
		 * email scanners that pre-fetch links can't burn the token.
		 */
		async peekLoginLink(token: string): Promise<{ email: string } | null> {
			if (!token) return null;
			await ensureSchema(db);
			const row = await db
				.prepare(
					`SELECT email FROM mbr_login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
				)
				.bind(await sha256Hex(token), now())
				.first<{ email: string }>();
			return row ? { email: row.email } : null;
		},

		/** Uses the link (once), creates the member on first sign-in, and starts a session. */
		async consumeLoginLink(token: string, opts: { userAgent?: string | null } = {}): Promise<ConsumeLinkResult> {
			if (!token) return { ok: false, reason: "invalid_or_expired" };
			await ensureSchema(db);
			const t = now();
			// Atomic single use: only one request can flip used_at from NULL.
			const link = await db
				.prepare(
					`UPDATE mbr_login_tokens SET used_at = ?
					 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
					 RETURNING email, next_path`,
				)
				.bind(t, await sha256Hex(token), t)
				.first<{ email: string; next_path: string | null }>();
			if (!link) return { ok: false, reason: "invalid_or_expired" };

			const row = await db
				.prepare(
					`INSERT INTO mbr_members (id, email, plan, created_at, last_login_at) VALUES (?, ?, 'free', ?, ?)
					 ON CONFLICT (email) DO UPDATE SET last_login_at = excluded.last_login_at
					 RETURNING id, email, plan, created_at, last_login_at`,
				)
				.bind(`mbr_${crypto.randomUUID()}`, link.email, t, t)
				.first<MemberRow>();
			if (!row) throw new Error("memberships: member upsert returned no row");

			const member = toMember(row);
			const session = await createSession(member.id, opts.userAgent);
			return { ok: true, member, session, next: safeNextPath(link.next_path) };
		},

		/** Resolves a session cookie to its member. Renews sessions past their half-life. */
		async getSession(token: string | null | undefined): Promise<ActiveSession | null> {
			if (!token || token.length > 128) return null;
			await ensureSchema(db);
			const hash = await sha256Hex(token);
			const t = now();
			const row = await db
				.prepare(
					`SELECT s.expires_at, m.id, m.email, m.plan, m.created_at, m.last_login_at
					 FROM mbr_sessions s JOIN mbr_members m ON m.id = s.member_id
					 WHERE s.token_hash = ? AND s.expires_at > ?`,
				)
				.bind(hash, t)
				.first<MemberRow & { expires_at: number }>();
			if (!row) return null;

			let expiresAt = row.expires_at;
			let renewed = false;
			if (expiresAt - t < sessionTtl / 2) {
				expiresAt = t + sessionTtl;
				renewed = true;
				await db
					.prepare(`UPDATE mbr_sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?`)
					.bind(expiresAt, t, hash)
					.run();
			}
			return { member: toMember(row), expiresAt, renewed };
		},

		/** The member with this email, or null if they've never signed in (or been granted anything). */
		async getMemberByEmail(rawEmail: string): Promise<Member | null> {
			const email = normalizeEmail(rawEmail);
			if (!email) return null;
			await ensureSchema(db);
			const row = await db
				.prepare(`SELECT id, email, plan, created_at, last_login_at FROM mbr_members WHERE email = ?`)
				.bind(email)
				.first<MemberRow>();
			return row ? toMember(row) : null;
		},

		async revokeSession(token: string | null | undefined): Promise<void> {
			if (!token) return;
			await ensureSchema(db);
			await db.prepare(`DELETE FROM mbr_sessions WHERE token_hash = ?`).bind(await sha256Hex(token)).run();
		},

		/** Signs a member out everywhere. */
		async revokeAllSessions(memberId: string): Promise<void> {
			await ensureSchema(db);
			await db.prepare(`DELETE FROM mbr_sessions WHERE member_id = ?`).bind(memberId).run();
		},
	};
}

export type Memberships = ReturnType<typeof createMemberships>;
