/**
 * Lifecycle emails about a member's paid plan: welcome, failed payment,
 * trial ending, cancellation scheduled, subscription ended, and a win-back
 * after a while.
 *
 * Webhook handling only *queues* an email (`mbr_outbox`, once per dedupe key);
 * `processOutbox()`, run from a scheduled job, sends what's due through any
 * `EmailTransport`. So a slow or failing mail provider never fails a webhook,
 * and a failed send is retried with backoff.
 *
 * Stripe can send receipts and card-expiry emails itself (Dashboard → Settings
 * → Customer emails); these cover what it doesn't.
 */
import { type Db, ensureSchema } from "./db.ts";
import { type Address, type EmailTransport } from "./transport.ts";

export const EMAIL_KINDS = [
	"welcome",
	"payment_failed",
	"trial_ending",
	"cancel_scheduled",
	"subscription_ended",
	"win_back",
	"gift_purchased",
	"gift_received",
	"gift_ending",
	"team_invite",
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const EMAIL_KIND_LABELS: Record<EmailKind, string> = {
	welcome: "Welcome (after a purchase)",
	payment_failed: "Payment failed",
	trial_ending: "Trial ending (3 days before)",
	cancel_scheduled: "Cancellation scheduled",
	subscription_ended: "Subscription ended",
	win_back: "Win-back (after the subscription ended)",
	gift_purchased: "Gift bought (to the buyer, with the code)",
	gift_received: "Gift received (to the recipient, on the delivery date)",
	gift_ending: "Gifted time ending (5 days before)",
	team_invite: "Team invitation",
};

export interface EmailTemplate {
	subject: string;
	/** Plain text. Blank lines separate paragraphs; URLs become links. Placeholders: see PLACEHOLDERS. */
	body: string;
}

export const PLACEHOLDERS = [
	"site_name",
	"plan_name",
	"date",
	"amount",
	"account_url",
	"pricing_url",
	"code",
	"gift_code",
	"gift_days",
	"gift_message",
	"giver_email",
	"recipient",
	"redeem_url",
	"team_name",
	"join_url",
] as const;

export const DEFAULT_TEMPLATES: Record<EmailKind, EmailTemplate> = {
	welcome: {
		subject: "Welcome to {{plan_name}}",
		body: "Thanks for joining {{site_name}} {{plan_name}}. Everything it includes is unlocked now.\n\nManage your plan, invoices and payment details any time: {{account_url}}",
	},
	payment_failed: {
		subject: "Your {{site_name}} payment didn't go through",
		body: "We couldn't take your payment of {{amount}} for {{plan_name}}. Your access continues while we retry{{date_suffix}}.\n\nUpdate your payment details here: {{account_url}}",
	},
	trial_ending: {
		subject: "Your {{plan_name}} trial ends {{date}}",
		body: "Your free trial of {{site_name}} {{plan_name}} ends on {{date}}, and your first payment of {{amount}} will be taken then.\n\nNothing to do if you'd like to stay. To change or cancel: {{account_url}}",
	},
	cancel_scheduled: {
		subject: "Your {{plan_name}} subscription is canceled",
		body: "Your {{site_name}} {{plan_name}} subscription won't renew. You keep everything it includes until {{date}}.\n\nChanged your mind? Resume any time before then: {{account_url}}",
	},
	subscription_ended: {
		subject: "Your {{plan_name}} access has ended",
		body: "Your {{site_name}} {{plan_name}} subscription has ended, and your account is on the free plan now.\n\nYou can come back whenever you like: {{pricing_url}}",
	},
	win_back: {
		subject: "Come back to {{site_name}}",
		body: "It's been a while since your {{plan_name}} subscription ended, and a lot has been added since.\n\nRejoin here: {{pricing_url}}{{code_line}}",
	},
	gift_purchased: {
		subject: "Your {{site_name}} gift is ready",
		body: "Thanks for giving {{gift_days}} days of {{site_name}} {{plan_name}}.{{recipient_line}}\n\nGift code: {{gift_code}}\nRedeem link: {{redeem_url}}\n\nYou can forward this email, or share the code however you like. It works once.",
	},
	gift_received: {
		subject: "You've been given {{site_name}} {{plan_name}}",
		body: "{{giver_email}} gave you {{gift_days}} days of {{site_name}} {{plan_name}}.{{message_block}}\n\nClaim it here: {{redeem_url}}\n\nGift code: {{gift_code}}",
	},
	gift_ending: {
		subject: "Your gifted {{plan_name}} ends {{date}}",
		body: "Your gifted {{site_name}} {{plan_name}} ends on {{date}}. To keep everything it includes, subscribe here: {{pricing_url}}",
	},
	team_invite: {
		subject: "Join {{team_name}} on {{site_name}}",
		body: "You've been invited to join {{team_name}} on {{site_name}}, which includes {{plan_name}}.\n\nAccept the invitation: {{join_url}}\n\nSign in with this email address to take your seat.",
	},
};

export interface LifecycleSettings {
	from: { email: string; name?: string } | null;
	replyTo: string | null;
	siteName: string;
	/** Absolute origin for links, e.g. https://example.com */
	siteUrl: string;
	accountPath: string;
	pricingPath: string;
	/** Kinds switched off are dropped instead of sent */
	enabled: Record<EmailKind, boolean>;
	templates: Partial<Record<EmailKind, EmailTemplate>>;
	/** Days after a subscription ends before the win-back email. 0 turns it off. */
	winBackDays: number;
	/** Optional promotion code offered in the win-back email */
	winBackCode: string | null;
	/** Page that redeems gift codes (`?code=` is appended) */
	giftRedeemPath: string;
}

export const DEFAULT_SETTINGS: LifecycleSettings = {
	from: null,
	replyTo: null,
	siteName: "",
	siteUrl: "",
	accountPath: "/account",
	pricingPath: "/pricing",
	enabled: Object.fromEntries(EMAIL_KINDS.map((k) => [k, true])) as Record<EmailKind, boolean>,
	templates: {},
	winBackDays: 30,
	winBackCode: null,
	giftRedeemPath: "/gift/redeem",
};

const SETTINGS_KEY = "lifecycle";

export async function getLifecycleSettings(db: Db): Promise<LifecycleSettings> {
	await ensureSchema(db);
	const r = await db.prepare(`SELECT value FROM mbr_settings WHERE key = ?`).bind(SETTINGS_KEY).first<{ value: string }>();
	let stored: Partial<LifecycleSettings> = {};
	try {
		stored = r ? JSON.parse(r.value) : {};
	} catch {
		/* defaults */
	}
	return { ...DEFAULT_SETTINGS, ...stored, enabled: { ...DEFAULT_SETTINGS.enabled, ...stored.enabled }, templates: { ...stored.templates } };
}

export async function saveLifecycleSettings(db: Db, patch: Partial<LifecycleSettings>): Promise<LifecycleSettings> {
	const next = { ...(await getLifecycleSettings(db)), ...patch };
	if (patch.enabled) next.enabled = { ...(await getLifecycleSettings(db)).enabled, ...patch.enabled };
	await db
		.prepare(`INSERT INTO mbr_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(SETTINGS_KEY, JSON.stringify(next))
		.run();
	return next;
}

/** Problems that stop emails from going out, for the admin. */
export function settingsProblems(s: LifecycleSettings): string[] {
	const p: string[] = [];
	if (!s.from?.email) p.push("Set a From address.");
	if (!/^https?:\/\//.test(s.siteUrl)) p.push("Set the site URL (https://…), used for links.");
	return p;
}

export interface QueuedEmail {
	kind: EmailKind;
	to: string;
	memberId?: string | null;
	/** Once per key: a retried webhook never queues a second copy */
	dedupeKey: string;
	data?: EmailData;
	sendAfter?: number;
}

export interface EmailData {
	planName?: string;
	/** A date the email talks about (renewal, trial end…), ms */
	date?: number | null;
	/** Amount in the smallest unit, with its currency */
	amount?: number | null;
	currency?: string | null;
	/** Next retry of a failed payment, ms */
	nextAttempt?: number | null;
	/** Gift and team emails */
	code?: string | null;
	days?: number | null;
	message?: string | null;
	giverEmail?: string | null;
	recipientEmail?: string | null;
	recipientName?: string | null;
	teamName?: string | null;
	/** For gifts: appended to the redeem page; for teams: the whole join path */
	path?: string | null;
}

/** Queues an email. Returns false when one with the same key is already queued or sent. */
export async function enqueueEmail(db: Db, e: QueuedEmail, now = Date.now()): Promise<boolean> {
	await ensureSchema(db);
	const rows = (
		await db
			.prepare(
				`INSERT INTO mbr_outbox (id, dedupe_key, member_id, kind, to_email, data, created_at, send_after)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
			)
			.bind(`out_${crypto.randomUUID()}`, e.dedupeKey, e.memberId ?? null, e.kind, e.to, JSON.stringify(e.data ?? {}), now, e.sendAfter ?? now)
			.all()
	).results;
	return rows.length > 0;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function money(amount: number | null | undefined, currency: string | null | undefined): string {
	if (amount == null) return "";
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency ?? "usd").toUpperCase() }).format(amount / 100);
	} catch {
		return `${(amount / 100).toFixed(2)} ${currency ?? ""}`.trim();
	}
}

const day = (ms: number | null | undefined) =>
	ms ? new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";

/** Renders one email from its template, with links and a simple layout. */
export function renderEmail(kind: EmailKind, data: EmailData, s: LifecycleSettings): { subject: string; text: string; html: string } {
	const tpl = s.templates[kind] ?? DEFAULT_TEMPLATES[kind];
	const base = s.siteUrl.replace(/\/$/, "");
	const vars: Record<string, string> = {
		site_name: s.siteName || new URL(base || "https://example.com").host,
		plan_name: data.planName ?? "your plan",
		date: day(data.date),
		amount: money(data.amount, data.currency),
		account_url: `${base}${s.accountPath}`,
		pricing_url: `${base}${s.pricingPath}`,
		code: s.winBackCode ?? "",
		date_suffix: data.nextAttempt ? ` (next attempt ${day(data.nextAttempt)})` : "",
		code_line: s.winBackCode ? `\n\nUse code ${s.winBackCode} at checkout for a welcome-back discount.` : "",
		gift_code: data.code ?? "",
		gift_days: data.days ? String(data.days) : "",
		gift_message: data.message ?? "",
		message_block: data.message ? `\n\n"${data.message}"` : "",
		giver_email: data.giverEmail ?? "Someone",
		recipient: data.recipientName || data.recipientEmail || "",
		recipient_line: data.recipientEmail ? ` We'll email ${data.recipientName || data.recipientEmail} the gift on the date you chose.` : "",
		redeem_url: `${base}${s.giftRedeemPath}${data.path ?? ""}`,
		team_name: data.teamName ?? "your team",
		join_url: `${base}${data.path ?? ""}`,
	};
	const fill = (str: string) => str.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
	const subject = fill(tpl.subject).replace(/\s+/g, " ").trim();
	const text = fill(tpl.body).trim();
	const paragraphs = text
		.split(/\n{2,}/)
		.map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1a56db">$1</a>').replace(/\n/g, "<br>")}</p>`)
		.join("");
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1f2328">${paragraphs}<p style="margin:24px 0 0;font-size:13px;color:#6b7280">${esc(vars.site_name)} · <a href="${esc(base)}" style="color:#6b7280">${esc(base.replace(/^https?:\/\//, ""))}</a></p></div></body></html>`;
	return { subject, text: `${text}\n\n— ${vars.site_name}\n${base}`, html };
}

export interface OutboxReport {
	sent: number;
	failed: number;
	skipped: number;
	/** Set when nothing could be sent (e.g. no From address) */
	error?: string;
}

const MAX_ATTEMPTS = 5;

/**
 * Sends due emails. Disabled kinds are dropped; a win-back is dropped when
 * the member holds a paid plan again. Failures retry after 5, 20, 80… minutes.
 */
export async function processOutbox(opts: {
	db: Db;
	transport: EmailTransport;
	/** Overrides the admin settings (e.g. from address fixed in code) */
	settings?: Partial<LifecycleSettings>;
	now?: number;
	limit?: number;
}): Promise<OutboxReport> {
	const { db, transport } = opts;
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const s = { ...(await getLifecycleSettings(db)), ...opts.settings };
	const report: OutboxReport = { sent: 0, failed: 0, skipped: 0 };
	const problems = settingsProblems(s);
	if (problems.length) return { ...report, error: problems.join(" ") };
	const { results } = await db
		.prepare(
			`SELECT o.*, (SELECT plan FROM mbr_members m WHERE m.id = o.member_id) AS member_plan,
				EXISTS (SELECT 1 FROM mbr_subscriptions s WHERE s.member_id = o.member_id AND s.status IN ('active', 'trialing', 'past_due')) AS subscribed
			 FROM mbr_outbox o WHERE o.sent_at IS NULL AND o.send_after <= ? AND o.attempts < ? ORDER BY o.send_after LIMIT ?`,
		)
		.bind(t, MAX_ATTEMPTS, opts.limit ?? 50)
		.all<{ id: string; kind: EmailKind; to_email: string; data: string; attempts: number; member_plan: string | null; subscribed: number }>();
	const done = (id: string, note: string | null) => db.prepare(`UPDATE mbr_outbox SET sent_at = ?, last_error = ? WHERE id = ?`).bind(t, note, id).run();
	for (const row of results) {
		const moot = (row.kind === "win_back" && (row.member_plan === "pro" || !s.winBackDays)) || (row.kind === "gift_ending" && !!row.subscribed);
		if (!EMAIL_KINDS.includes(row.kind) || s.enabled[row.kind] === false || moot) {
			await done(row.id, "skipped");
			report.skipped++;
			continue;
		}
		let data: EmailData = {};
		try {
			data = JSON.parse(row.data);
		} catch {
			/* render with defaults */
		}
		const { subject, text, html } = renderEmail(row.kind, data, s);
		try {
			await transport.send({
				from: s.from as Address,
				to: row.to_email,
				...(s.replyTo && { replyTo: s.replyTo }),
				subject,
				text,
				html,
				category: `membership-${row.kind}`,
			});
			await done(row.id, null);
			report.sent++;
		} catch (err) {
			const attempts = row.attempts + 1;
			await db
				.prepare(`UPDATE mbr_outbox SET attempts = ?, send_after = ?, last_error = ? WHERE id = ?`)
				.bind(attempts, t + 5 * 60_000 * 4 ** (attempts - 1), String((err as Error)?.message ?? err).slice(0, 300), row.id)
				.run();
			report.failed++;
		}
	}
	return report;
}

export interface OutboxItem {
	id: string;
	kind: EmailKind;
	to: string;
	createdAt: number;
	sendAfter: number;
	sentAt: number | null;
	attempts: number;
	lastError: string | null;
}

/** Recent outbox rows for the admin, newest first. */
export async function listOutbox(db: Db, opts: { limit?: number; memberId?: string } = {}): Promise<OutboxItem[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_outbox ${opts.memberId ? "WHERE member_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`)
		.bind(...(opts.memberId ? [opts.memberId] : []), opts.limit ?? 50)
		.all<{ id: string; kind: EmailKind; to_email: string; created_at: number; send_after: number; sent_at: number | null; attempts: number; last_error: string | null }>();
	return results.map((r) => ({
		id: r.id,
		kind: r.kind,
		to: r.to_email,
		createdAt: r.created_at,
		sendAfter: r.send_after,
		sentAt: r.sent_at,
		attempts: r.attempts,
		lastError: r.last_error,
	}));
}
