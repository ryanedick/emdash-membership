/**
 * Membership events: one log, three consumers.
 *
 * Everything that changes a member's standing emits an event. Each event is
 * stored in `mbr_events` (the admin shows a member's timeline from it),
 * handed to in-process listeners (`onMemberEvent`, e.g. another plugin
 * tagging newsletter subscribers), and queued for every outbound webhook
 * subscribed to its type. `processWebhooks()` delivers those with an HMAC
 * signature and retries, so Zapier, Make, n8n or your own service can follow
 * along.
 */
import { randomToken } from "./crypto.ts";
import { type Db, ensureSchema } from "./db.ts";

export const EVENT_TYPES = [
	"member.created",
	"member.plans_changed",
	"member.profile_updated",
	"member.deleted",
	"checkout.completed",
	"subscription.updated",
	"subscription.cancel_scheduled",
	"subscription.ended",
	"payment.failed",
	"gift.purchased",
	"gift.redeemed",
	"team.created",
	"team.member_joined",
	"team.member_removed",
	"download.fetched",
] as const;
export type MemberEventType = (typeof EVENT_TYPES)[number];

export interface MemberEvent {
	id: string;
	type: MemberEventType;
	memberId: string | null;
	data: Record<string, unknown>;
	createdAt: number;
}

type Listener = (event: MemberEvent) => void | Promise<void>;
const listeners = new Set<Listener>();

/** Runs `fn` for every event emitted in this isolate. Returns an unsubscribe function. */
export function onMemberEvent(fn: Listener): () => void {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}

/** Records an event, queues its webhook deliveries and tells listeners. Never throws for a listener's error. */
export async function emitEvent(
	db: Db,
	type: MemberEventType,
	memberId: string | null,
	data: Record<string, unknown> = {},
	now = Date.now(),
): Promise<MemberEvent> {
	await ensureSchema(db);
	const event: MemberEvent = { id: `evt_${crypto.randomUUID()}`, type, memberId, data, createdAt: now };
	const { results: hooks } = await db.prepare(`SELECT id, events FROM mbr_webhooks WHERE active = 1`).all<{ id: string; events: string }>();
	const targets = hooks.filter((h) => {
		const types = parseList(h.events);
		return types.length === 0 || types.includes(type) || types.includes("*");
	});
	await db.batch([
		db.prepare(`INSERT INTO mbr_events (id, type, member_id, data, created_at) VALUES (?, ?, ?, ?, ?)`).bind(event.id, type, memberId, JSON.stringify(data), now),
		...targets.map((h) =>
			db
				.prepare(`INSERT INTO mbr_webhook_deliveries (id, webhook_id, event_id, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
				.bind(`dlv_${crypto.randomUUID()}`, h.id, event.id, now, now),
		),
	]);
	for (const fn of listeners) {
		try {
			await fn(event);
		} catch (err) {
			console.error(`[memberships] event listener failed for ${type}`, err);
		}
	}
	return event;
}

function parseList(json: string | null): string[] {
	try {
		const v = JSON.parse(json ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

const toEvent = (r: { id: string; type: string; member_id: string | null; data: string; created_at: number }): MemberEvent => {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(r.data);
	} catch {
		/* empty */
	}
	return { id: r.id, type: r.type as MemberEventType, memberId: r.member_id, data, createdAt: r.created_at };
};

/** Events newest first, optionally for one member or one type. */
export async function listEvents(db: Db, opts: { memberId?: string; type?: string; limit?: number; before?: number } = {}): Promise<MemberEvent[]> {
	await ensureSchema(db);
	const where: string[] = [];
	const args: unknown[] = [];
	if (opts.memberId) where.push("member_id = ?"), args.push(opts.memberId);
	if (opts.type) where.push("type = ?"), args.push(opts.type);
	if (opts.before) where.push("created_at < ?"), args.push(opts.before);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
		.bind(...args, Math.min(opts.limit ?? 50, 500))
		.all<{ id: string; type: string; member_id: string | null; data: string; created_at: number }>();
	return results.map(toEvent);
}

// ─────────────────────────────── outbound webhooks ───────────────────────────────

export interface Webhook {
	id: string;
	url: string;
	/** Shown once on creation, and in the admin; used to sign deliveries */
	secret: string;
	/** Event types; empty means all */
	events: string[];
	active: boolean;
	createdAt: number;
}

export async function listWebhooks(db: Db): Promise<Webhook[]> {
	await ensureSchema(db);
	const { results } = await db.prepare(`SELECT * FROM mbr_webhooks ORDER BY created_at`).all<{ id: string; url: string; secret: string; events: string; active: number; created_at: number }>();
	return results.map((r) => ({ id: r.id, url: r.url, secret: r.secret, events: parseList(r.events), active: !!r.active, createdAt: r.created_at }));
}

export type CreateWebhookResult = { ok: true; webhook: Webhook } | { ok: false; reason: "invalid_url" | "unknown_event" };

/** Adds an endpoint. Only https URLs (http only for localhost). */
export async function createWebhook(db: Db, input: { url: string; events?: readonly string[] }, now = Date.now()): Promise<CreateWebhookResult> {
	await ensureSchema(db);
	let url: URL;
	try {
		url = new URL(input.url.trim());
	} catch {
		return { ok: false, reason: "invalid_url" };
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return { ok: false, reason: "invalid_url" };
	const events = [...new Set((input.events ?? []).map((e) => e.trim()).filter(Boolean))];
	if (events.some((e) => e !== "*" && !EVENT_TYPES.includes(e as MemberEventType))) return { ok: false, reason: "unknown_event" };
	const id = `whk_${crypto.randomUUID()}`;
	await db
		.prepare(`INSERT INTO mbr_webhooks (id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
		.bind(id, url.toString(), `mbrsec_${randomToken(24)}`, JSON.stringify(events), now)
		.run();
	return { ok: true, webhook: (await listWebhooks(db)).find((w) => w.id === id)! };
}

export async function setWebhookActive(db: Db, id: string, active: boolean): Promise<void> {
	await db.prepare(`UPDATE mbr_webhooks SET active = ? WHERE id = ?`).bind(active ? 1 : 0, id).run();
}

export async function deleteWebhook(db: Db, id: string): Promise<void> {
	await db.batch([db.prepare(`DELETE FROM mbr_webhook_deliveries WHERE webhook_id = ?`).bind(id), db.prepare(`DELETE FROM mbr_webhooks WHERE id = ?`).bind(id)]);
}

async function hmacHex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `X-Membership-Signature` header value for a body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export async function signWebhook(secret: string, body: string, nowMs = Date.now()): Promise<string> {
	const t = Math.floor(nowMs / 1000);
	return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** For receivers: checks a signature header and that it's at most `toleranceSeconds` old. */
export async function verifyWebhookSignature(secret: string, body: string, header: string | null, opts: { toleranceSeconds?: number; now?: number } = {}): Promise<boolean> {
	if (!header) return false;
	const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
	const t = Number(parts.t);
	if (!Number.isFinite(t) || !parts.v1) return false;
	if (Math.abs((opts.now ?? Date.now()) / 1000 - t) > (opts.toleranceSeconds ?? 300)) return false;
	const expected = await hmacHex(secret, `${t}.${body}`);
	if (expected.length !== parts.v1.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
	return diff === 0;
}

export interface WebhookReport {
	delivered: number;
	failed: number;
}

const MAX_WEBHOOK_ATTEMPTS = 8;

/** Delivers due webhook events. Non-2xx answers retry after 1, 4, 16… minutes, up to 8 tries. */
export async function processWebhooks(opts: { db: Db; fetch?: typeof fetch; now?: number; limit?: number }): Promise<WebhookReport> {
	const { db } = opts;
	await ensureSchema(db);
	const doFetch = opts.fetch ?? fetch;
	const t = opts.now ?? Date.now();
	const { results } = await db
		.prepare(
			`SELECT d.id, d.attempts, w.url, w.secret, e.id AS event_id, e.type, e.member_id, e.data, e.created_at
			 FROM mbr_webhook_deliveries d JOIN mbr_webhooks w ON w.id = d.webhook_id JOIN mbr_events e ON e.id = d.event_id
			 WHERE d.delivered_at IS NULL AND d.next_attempt_at <= ? AND d.attempts < ? AND w.active = 1
			 ORDER BY d.next_attempt_at LIMIT ?`,
		)
		.bind(t, MAX_WEBHOOK_ATTEMPTS, opts.limit ?? 50)
		.all<{ id: string; attempts: number; url: string; secret: string; event_id: string; type: string; member_id: string | null; data: string; created_at: number }>();
	const report: WebhookReport = { delivered: 0, failed: 0 };
	for (const r of results) {
		const event = toEvent({ id: r.event_id, type: r.type, member_id: r.member_id, data: r.data, created_at: r.created_at });
		const body = JSON.stringify({ id: event.id, type: event.type, created: new Date(event.createdAt).toISOString(), member_id: event.memberId, data: event.data });
		let status: number | null = null;
		let error: string | null = null;
		try {
			const res = await doFetch(r.url, {
				method: "POST",
				headers: { "content-type": "application/json", "x-membership-event": event.type, "x-membership-signature": await signWebhook(r.secret, body, t) },
				body,
				signal: AbortSignal.timeout(10_000),
			});
			status = res.status;
			if (!res.ok) error = `HTTP ${res.status}`;
		} catch (err) {
			error = String((err as Error)?.message ?? err).slice(0, 200);
		}
		if (!error) {
			await db.prepare(`UPDATE mbr_webhook_deliveries SET attempts = attempts + 1, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?`).bind(status, t, r.id).run();
			report.delivered++;
		} else {
			const attempts = r.attempts + 1;
			await db
				.prepare(`UPDATE mbr_webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
				.bind(attempts, status, error, t + 60_000 * 4 ** (attempts - 1), r.id)
				.run();
			report.failed++;
		}
	}
	return report;
}

export interface Delivery {
	id: string;
	eventId: string;
	eventType: string;
	attempts: number;
	lastStatus: number | null;
	lastError: string | null;
	deliveredAt: number | null;
	nextAttemptAt: number;
}

export async function listDeliveries(db: Db, webhookId: string, limit = 20): Promise<Delivery[]> {
	const { results } = await db
		.prepare(
			`SELECT d.*, e.type FROM mbr_webhook_deliveries d JOIN mbr_events e ON e.id = d.event_id WHERE d.webhook_id = ? ORDER BY d.created_at DESC LIMIT ?`,
		)
		.bind(webhookId, limit)
		.all<{ id: string; event_id: string; type: string; attempts: number; last_status: number | null; last_error: string | null; delivered_at: number | null; next_attempt_at: number }>();
	return results.map((r) => ({
		id: r.id,
		eventId: r.event_id,
		eventType: r.type,
		attempts: r.attempts,
		lastStatus: r.last_status,
		lastError: r.last_error,
		deliveredAt: r.delivered_at,
		nextAttemptAt: r.next_attempt_at,
	}));
}

// ─────────────────────────────── staff notes and audit ───────────────────────────────

export async function addNote(db: Db, memberId: string, body: string, author: string | null, now = Date.now()): Promise<void> {
	const text = body.trim().slice(0, 4000);
	if (!text) return;
	await db.prepare(`INSERT INTO mbr_notes (id, member_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`).bind(`note_${crypto.randomUUID()}`, memberId, author, text, now).run();
}

export async function listNotes(db: Db, memberId: string): Promise<{ id: string; author: string | null; body: string; createdAt: number }[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_notes WHERE member_id = ? ORDER BY created_at DESC`)
		.bind(memberId)
		.all<{ id: string; author: string | null; body: string; created_at: number }>();
	return results.map((r) => ({ id: r.id, author: r.author, body: r.body, createdAt: r.created_at }));
}

export async function deleteNote(db: Db, id: string): Promise<void> {
	await db.prepare(`DELETE FROM mbr_notes WHERE id = ?`).bind(id).run();
}

/** Records a staff action (who did what to which member). */
export async function audit(db: Db, entry: { actor: string | null; action: string; memberId?: string | null; detail?: string | null }, now = Date.now()): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(`INSERT INTO mbr_audit (actor, action, member_id, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(entry.actor, entry.action, entry.memberId ?? null, entry.detail?.slice(0, 500) ?? null, now)
		.run();
}

export async function listAudit(db: Db, opts: { memberId?: string; limit?: number } = {}): Promise<{ actor: string | null; action: string; memberId: string | null; detail: string | null; createdAt: number }[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_audit ${opts.memberId ? "WHERE member_id = ?" : ""} ORDER BY id DESC LIMIT ?`)
		.bind(...(opts.memberId ? [opts.memberId] : []), opts.limit ?? 50)
		.all<{ actor: string | null; action: string; member_id: string | null; detail: string | null; created_at: number }>();
	return results.map((r) => ({ actor: r.actor, action: r.action, memberId: r.member_id, detail: r.detail, createdAt: r.created_at }));
}
