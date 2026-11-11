/**
 * Profile fields: questions staff define in the admin ("Which AI tools do you
 * use?", "Role"), asked at sign-up or on the account page, stored per member
 * and exported. Values are validated against the field definition on save.
 */
import { type Db, ensureSchema } from "./db.ts";
import { emitEvent } from "./events.ts";

export type ProfileFieldType = "text" | "textarea" | "select" | "multiselect" | "checkbox" | "url";

export interface ProfileField {
	/** Stable id, e.g. "tools" */
	key: string;
	label: string;
	type: ProfileFieldType;
	/** Choices for select and multiselect */
	options: string[];
	required: boolean;
	/** Ask on the sign-up / onboarding form, not only the account page */
	atSignup: boolean;
	sortOrder: number;
}

export type ProfileValue = string | string[] | boolean;
export type Profile = Record<string, ProfileValue>;

const TYPES: ProfileFieldType[] = ["text", "textarea", "select", "multiselect", "checkbox", "url"];

export async function listProfileFields(db: Db): Promise<ProfileField[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM mbr_profile_fields ORDER BY sort_order, created_at`)
		.all<{ key: string; label: string; type: string; options: string; required: number; at_signup: number; sort_order: number }>();
	return results.map((r) => ({
		key: r.key,
		label: r.label,
		type: (TYPES.includes(r.type as ProfileFieldType) ? r.type : "text") as ProfileFieldType,
		options: safeList(r.options),
		required: !!r.required,
		atSignup: !!r.at_signup,
		sortOrder: r.sort_order,
	}));
}

function safeList(json: string): string[] {
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

export type SaveFieldResult = { ok: true; field: ProfileField } | { ok: false; reason: "invalid_key" | "invalid_label" | "invalid_type" | "options_required" };

export async function saveProfileField(db: Db, f: Omit<ProfileField, "sortOrder" | "options" | "required" | "atSignup"> & Partial<ProfileField>, now = Date.now()): Promise<SaveFieldResult> {
	await ensureSchema(db);
	const key = f.key.trim().toLowerCase();
	if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) return { ok: false, reason: "invalid_key" };
	const label = f.label.trim();
	if (!label || label.length > 120) return { ok: false, reason: "invalid_label" };
	if (!TYPES.includes(f.type)) return { ok: false, reason: "invalid_type" };
	const options = [...new Set((f.options ?? []).map((o) => o.trim()).filter(Boolean))].slice(0, 50);
	if ((f.type === "select" || f.type === "multiselect") && !options.length) return { ok: false, reason: "options_required" };
	await db
		.prepare(
			`INSERT INTO mbr_profile_fields (key, label, type, options, required, at_signup, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET label = excluded.label, type = excluded.type, options = excluded.options,
			   required = excluded.required, at_signup = excluded.at_signup, sort_order = excluded.sort_order`,
		)
		.bind(key, label, f.type, JSON.stringify(options), f.required ? 1 : 0, f.atSignup ? 1 : 0, Math.floor(f.sortOrder ?? 0), now)
		.run();
	return { ok: true, field: (await listProfileFields(db)).find((x) => x.key === key)! };
}

/** Removes a field and everyone's answers to it. */
export async function deleteProfileField(db: Db, key: string): Promise<void> {
	await db.batch([db.prepare(`DELETE FROM mbr_profile_values WHERE key = ?`).bind(key), db.prepare(`DELETE FROM mbr_profile_fields WHERE key = ?`).bind(key)]);
}

export async function getProfile(db: Db, memberId: string): Promise<Profile> {
	await ensureSchema(db);
	const { results } = await db.prepare(`SELECT key, value FROM mbr_profile_values WHERE member_id = ?`).bind(memberId).all<{ key: string; value: string }>();
	const out: Profile = {};
	for (const r of results) {
		try {
			out[r.key] = JSON.parse(r.value) as ProfileValue;
		} catch {
			/* skip */
		}
	}
	return out;
}

/** Turns raw input (form strings, arrays, booleans) into a valid value for the field, or null when empty/invalid. */
export function coerceProfileValue(field: ProfileField, raw: unknown): ProfileValue | null {
	switch (field.type) {
		case "checkbox":
			return raw === true || raw === "true" || raw === "on" || raw === "1";
		case "multiselect": {
			const arr = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : [];
			const picked = arr.map((s) => s.trim()).filter((s) => field.options.includes(s));
			return picked.length ? [...new Set(picked)] : null;
		}
		case "select": {
			const v = String(raw ?? "").trim();
			return field.options.includes(v) ? v : null;
		}
		case "url": {
			const v = String(raw ?? "").trim();
			if (!v) return null;
			try {
				const u = new URL(v);
				return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
			} catch {
				return null;
			}
		}
		default: {
			const v = String(raw ?? "").trim().slice(0, field.type === "textarea" ? 4000 : 300);
			return v || null;
		}
	}
}

export type SaveProfileResult = { ok: true; profile: Profile } | { ok: false; missing: string[] };

/**
 * Saves the answers given. Unknown keys are ignored; an empty answer clears the
 * value. With `requireAll`, required fields that end up empty are reported
 * and nothing is saved.
 */
export async function saveProfile(db: Db, memberId: string, input: Record<string, unknown>, opts: { requireAll?: boolean; signupOnly?: boolean; now?: number } = {}): Promise<SaveProfileResult> {
	const t = opts.now ?? Date.now();
	const fields = (await listProfileFields(db)).filter((f) => !opts.signupOnly || f.atSignup);
	const current = await getProfile(db, memberId);
	const next: Profile = { ...current };
	for (const f of fields) {
		if (!(f.key in input) && f.type !== "checkbox") continue;
		if (!(f.key in input) && f.type === "checkbox" && !opts.requireAll) continue;
		const v = coerceProfileValue(f, input[f.key]);
		if (v === null) delete next[f.key];
		else next[f.key] = v;
	}
	if (opts.requireAll) {
		const missing = fields.filter((f) => f.required && (next[f.key] === undefined || next[f.key] === false)).map((f) => f.key);
		if (missing.length) return { ok: false, missing };
	}
	const writes = fields.map((f) =>
		next[f.key] === undefined
			? db.prepare(`DELETE FROM mbr_profile_values WHERE member_id = ? AND key = ?`).bind(memberId, f.key)
			: db
					.prepare(
						`INSERT INTO mbr_profile_values (member_id, key, value, updated_at) VALUES (?, ?, ?, ?)
						 ON CONFLICT (member_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
					)
					.bind(memberId, f.key, JSON.stringify(next[f.key]), t),
	);
	if (writes.length) await db.batch(writes);
	if (JSON.stringify(current) !== JSON.stringify(next)) await emitEvent(db, "member.profile_updated", memberId, { profile: next }, t);
	return { ok: true, profile: next };
}

/** True when the member still owes answers to required sign-up questions (send them to onboarding). */
export async function needsOnboarding(db: Db, memberId: string): Promise<boolean> {
	const fields = (await listProfileFields(db)).filter((f) => f.atSignup && f.required);
	if (!fields.length) return false;
	const p = await getProfile(db, memberId);
	return fields.some((f) => p[f.key] === undefined || p[f.key] === false);
}
