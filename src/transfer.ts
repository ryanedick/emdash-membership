/**
 * Moving members in and out.
 *
 * Export: one CSV row per member with plans, entitlements, billing state and
 * profile answers.
 *
 * Import: a CSV with an email column, from a spreadsheet or another platform's
 * member export. Columns are recognised by common names (email, name, plan,
 * tier, status, complimentary plan, Stripe customer id, created date, labels),
 * so exports from most newsletter and membership tools work as they are.
 * Imported members are created on Free; a `plan` with `days` gives comp time;
 * a Stripe customer id is returned for linking (`billing.linkCustomer`), which
 * pulls in an existing subscription without charging anyone again.
 */
import { type Db, ensureSchema } from "./db.ts";
import { emitEvent } from "./events.ts";
import { grantProTime } from "./grants.ts";
import { normalizeEmail } from "./memberships.ts";
import { getPlan, listPlans } from "./plans.ts";
import { listProfileFields, saveProfile } from "./profile.ts";

/** Parses CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const s = text.replace(/^﻿/, "");
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quoted) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
			continue;
		}
		if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && s[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((c) => c !== "")) rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	row.push(field);
	if (row.some((c) => c !== "")) rows.push(row);
	return rows;
}

export function csvCell(v: unknown): string {
	const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v);
	// Quote when needed; prefix formula-looking values so spreadsheets don't execute them.
	const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");

/** Every member as CSV, newest first. */
export async function exportMembersCsv(db: Db, opts: { paidOnly?: boolean } = {}): Promise<string> {
	await ensureSchema(db);
	const fields = await listProfileFields(db);
	const { results } = await db
		.prepare(
			`SELECT m.id, m.email, m.plan, m.created_at, m.last_login_at, a.plans, a.entitlements, b.early_member, b.stripe_customer_id,
				(SELECT s.status FROM mbr_subscriptions s WHERE s.member_id = m.id ORDER BY s.updated_at DESC LIMIT 1) AS sub_status
			 FROM mbr_members m LEFT JOIN mbr_member_access a ON a.member_id = m.id LEFT JOIN mbr_billing b ON b.member_id = m.id
			 ${opts.paidOnly ? "WHERE m.plan = 'pro'" : ""} ORDER BY m.created_at DESC`,
		)
		.all<{ id: string; email: string; plan: string; created_at: number; last_login_at: number | null; plans: string | null; entitlements: string | null; early_member: number | null; stripe_customer_id: string | null; sub_status: string | null }>();
	const profiles = new Map<string, Record<string, unknown>>();
	if (fields.length) {
		const { results: values } = await db.prepare(`SELECT member_id, key, value FROM mbr_profile_values`).all<{ member_id: string; key: string; value: string }>();
		for (const v of values) {
			const p = profiles.get(v.member_id) ?? {};
			try {
				p[v.key] = JSON.parse(v.value);
			} catch {
				/* skip */
			}
			profiles.set(v.member_id, p);
		}
	}
	const list = (j: string | null) => {
		try {
			return (JSON.parse(j ?? "[]") as string[]).join("; ");
		} catch {
			return "";
		}
	};
	const header = ["email", "created_at", "last_sign_in", "paid", "plans", "entitlements", "early_member", "subscription_status", "stripe_customer_id", ...fields.map((f) => f.key)];
	const lines = results.map((r) => {
		const p = profiles.get(r.id) ?? {};
		return [r.email, iso(r.created_at), iso(r.last_login_at), r.plan === "pro", list(r.plans), list(r.entitlements), !!r.early_member, r.sub_status ?? "", r.stripe_customer_id ?? "", ...fields.map((f) => p[f.key] ?? "")]
			.map(csvCell)
			.join(",");
	});
	return [header.join(","), ...lines].join("\n");
}

const ALIASES: Record<string, string[]> = {
	email: ["email", "email address", "email_address", "e-mail", "subscriber email", "member email"],
	name: ["name", "full name", "full_name", "first_name", "first name"],
	plan: ["plan", "membership", "membership level", "level"],
	tier: ["tier", "tiers", "subscription_tier", "subscription tier", "subscription type", "type", "paid"],
	status: ["status", "subscription status", "subscription_status", "member status", "active_subscription"],
	comp: ["complimentary_plan", "complimentary", "comped"],
	days: ["days", "comp days", "comp_days"],
	expires: ["expiry", "expires", "expires_at", "expiration", "expiration date", "end date", "paid_until"],
	stripe: ["stripe_customer_id", "stripe customer id", "stripe customer", "customer_id"],
	created: ["created_at", "created", "created date", "subscribed_at", "subscription date", "joined", "join date", "signup date"],
	labels: ["labels", "tags"],
};

function columnMap(header: string[]): Partial<Record<keyof typeof ALIASES, number>> {
	const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
	const out: Partial<Record<keyof typeof ALIASES, number>> = {};
	for (const [k, names] of Object.entries(ALIASES)) {
		const i = norm.findIndex((h) => names.includes(h));
		if (i >= 0) out[k as keyof typeof ALIASES] = i;
	}
	return out;
}

const PAID_WORDS = /^(paid|premium|pro|true|yes|1|active|comped?|gift|founding)$/i;

export interface ImportOptions {
	/** Plan for rows marked paid (by tier/status/complimentary) without a plan column. Default: the fallback paid plan. */
	paidPlan?: string;
	/** Days of comp time for paid rows without an expiry or days column. 0 = don't grant. Default 0. */
	paidDays?: number;
	/** Recorded on the member.created event */
	source?: string;
	/** Validate only, write nothing */
	dryRun?: boolean;
	now?: number;
}

export interface ImportReport {
	rows: number;
	created: number;
	existing: number;
	granted: number;
	profiles: number;
	/** Members with a Stripe customer id to link with `billing.linkCustomer` */
	toLink: { memberId: string; email: string; customerId: string }[];
	errors: { row: number; error: string }[];
	/** Columns recognised, for showing what was understood */
	columns: string[];
}

/** Imports members from CSV text. Existing members (by email) are kept; their plan and profile are added to. */
export async function importMembersCsv(db: Db, csv: string, opts: ImportOptions = {}): Promise<ImportReport> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const rows = parseCsv(csv);
	const report: ImportReport = { rows: Math.max(0, rows.length - 1), created: 0, existing: 0, granted: 0, profiles: 0, toLink: [], errors: [], columns: [] };
	if (!rows.length) return report;
	const header = rows[0];
	const map = columnMap(header);
	report.columns = Object.keys(map);
	if (map.email === undefined) {
		report.errors.push({ row: 1, error: "No email column found" });
		return report;
	}
	const plans = new Map((await listPlans(db, { includeArchived: true })).map((p) => [p.id.toLowerCase(), p]));
	const planByName = new Map([...plans.values()].map((p) => [p.name.toLowerCase(), p]));
	const fields = await listProfileFields(db);
	const fieldCols = fields.map((f) => ({ f, i: header.findIndex((h) => h.trim().toLowerCase() === f.key || h.trim().toLowerCase() === f.label.toLowerCase()) })).filter((x) => x.i >= 0);
	const paidPlan = opts.paidPlan ?? null;
	const cell = (r: string[], k: keyof typeof ALIASES) => (map[k] === undefined ? "" : (r[map[k]!] ?? "").trim());

	for (let n = 1; n < rows.length; n++) {
		const r = rows[n];
		const email = normalizeEmail(cell(r, "email"));
		if (!email) {
			report.errors.push({ row: n + 1, error: `Invalid email "${cell(r, "email")}"` });
			continue;
		}
		const planCell = cell(r, "plan").toLowerCase();
		const named = planCell ? (plans.get(planCell) ?? planByName.get(planCell)) : undefined;
		if (planCell && !named) {
			report.errors.push({ row: n + 1, error: `Unknown plan "${cell(r, "plan")}"` });
			continue;
		}
		const paidFlag = [cell(r, "tier"), cell(r, "comp"), cell(r, "status")].some((v) => PAID_WORDS.test(v)) || (!!named && named.paid);
		const expires = Date.parse(cell(r, "expires"));
		const days = Number(cell(r, "days")) || (Number.isFinite(expires) && expires > t ? Math.ceil((expires - t) / 86_400_000) : opts.paidDays ?? 0);
		const created = Date.parse(cell(r, "created"));
		if (opts.dryRun) continue;

		const isNew = !(await db.prepare(`SELECT 1 FROM mbr_members WHERE email = ?`).bind(email).first());
		const row = await db
			.prepare(
				`INSERT INTO mbr_members (id, email, plan, created_at) VALUES (?, ?, 'free', ?)
				 ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id, created_at`,
			)
			.bind(`mbr_${crypto.randomUUID()}`, email, Number.isFinite(created) && created < t ? created : t)
			.first<{ id: string; created_at: number }>();
		if (!row) continue;
		if (isNew) {
			report.created++;
			await emitEvent(db, "member.created", row.id, { email, source: opts.source ?? "import" }, t);
		} else report.existing++;

		if (paidFlag && days > 0) {
			const plan = named?.paid ? named.id : paidPlan;
			const g = await grantProTime(db, { email, days, plan: plan ?? undefined, key: `import:${email}:${plan ?? "default"}`, reason: `Imported${opts.source ? ` from ${opts.source}` : ""}`, now: t });
			if (g.ok && g.created) report.granted++;
			else if (!g.ok) report.errors.push({ row: n + 1, error: `Couldn't grant time: ${g.reason}` });
		}
		const customer = cell(r, "stripe");
		if (/^cus_[A-Za-z0-9]+$/.test(customer)) report.toLink.push({ memberId: row.id, email, customerId: customer });
		if (fieldCols.length) {
			const answers = Object.fromEntries(fieldCols.map(({ f, i }) => [f.key, r[i] ?? ""]).filter(([, v]) => v !== ""));
			if (Object.keys(answers).length) {
				await saveProfile(db, row.id, answers, { now: t });
				report.profiles++;
			}
		}
	}
	return report;
}

/** Gives every member matching a filter some time on a plan (bulk action). Returns how many got it. */
export async function bulkGrant(db: Db, input: { emails: string[]; plan?: string; days: number; reason: string; batchKey: string; now?: number }): Promise<number> {
	if (input.plan && !(await getPlan(db, input.plan))?.paid) return 0;
	let n = 0;
	for (const email of input.emails) {
		const g = await grantProTime(db, { email, days: input.days, plan: input.plan, key: `bulk:${input.batchKey}:${email}`, reason: input.reason, now: input.now });
		if (g.ok && g.created) n++;
	}
	return n;
}
