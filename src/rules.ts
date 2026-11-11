/**
 * Access rules: which content needs what, set in the admin instead of coded
 * into every page.
 *
 * A rule targets a collection, a taxonomy term, one entry, or a path pattern,
 * and requires an entitlement (or just being signed in). Exceptions open it
 * up: free for N hours after a date field (e.g. 72 hours after publishing),
 * always free when a boolean field is set, and drip (available N days after
 * the member joined). When access is refused, the rule says what to show: a
 * teaser plus paywall, or a redirect.
 *
 * Pages call `checkAccess(db, member, content)` with what they know about the
 * entry and render the decision. Evaluation is server-side; never hide gated
 * content with CSS.
 */
import { type Db, ensureSchema } from "./db.ts";
import { can } from "./plans.ts";

export type RuleTargetType = "collection" | "term" | "entry" | "path";

export interface AccessRule {
	id: string;
	name: string;
	targetType: RuleTargetType;
	/**
	 * collection: "tips" · term: "category:prompting" (taxonomy:term) ·
	 * entry: "tips/my-slug" (collection/slug or id) · path: "/courses/*" (* matches anything)
	 */
	target: string;
	requirement: "entitlement" | "signed_in";
	entitlement: string | null;
	/** Name of a date field; the entry is free for `freeHours` after it */
	freeDateField: string | null;
	freeHours: number;
	/** Name of a boolean field; true makes the entry free */
	freeFlagField: string | null;
	/** Entitled members see it only this many days after they joined */
	dripDays: number;
	lockedView: "teaser" | "redirect";
	/** Portable Text blocks shown before the paywall */
	teaserBlocks: number;
	redirectTo: string | null;
	/** Higher wins among equally specific rules */
	priority: number;
	active: boolean;
}

export interface ContentContext {
	collection?: string;
	/** Entry id and/or slug, either matches an entry rule */
	id?: string;
	slug?: string;
	/** "taxonomy:term" pairs, e.g. ["category:prompting", "tools:claude"] */
	terms?: readonly string[];
	path?: string;
	/** Fields the rule may read (date and flag fields) */
	fields?: Record<string, unknown>;
}

export interface AccessMember {
	plan?: string;
	entitlements?: readonly string[];
	createdAt?: number;
}

export type AccessReason = "no_rule" | "entitled" | "signed_in" | "free_window" | "free_flag" | "locked" | "sign_in_required" | "drip";

export interface AccessDecision {
	allowed: boolean;
	reason: AccessReason;
	rule: AccessRule | null;
	/** What to show when not allowed */
	view: "teaser" | "redirect" | null;
	teaserBlocks: number;
	redirectTo: string | null;
	/** The entitlement that would unlock it */
	requires: string | null;
	/** Free-window end, when the entry is free because of it (show "free until…") */
	freeUntil: number | null;
	/** Drip: when it unlocks for this member */
	availableAt: number | null;
}

const SPECIFICITY: Record<RuleTargetType, number> = { entry: 4, term: 3, collection: 2, path: 1 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface RuleRow {
	id: string;
	name: string;
	target_type: string;
	target: string;
	requirement: string;
	entitlement: string | null;
	free_date_field: string | null;
	free_hours: number;
	free_flag_field: string | null;
	drip_days: number;
	locked_view: string;
	teaser_blocks: number;
	redirect_to: string | null;
	priority: number;
	active: number;
}

const toRule = (r: RuleRow): AccessRule => ({
	id: r.id,
	name: r.name,
	targetType: (["collection", "term", "entry", "path"].includes(r.target_type) ? r.target_type : "collection") as RuleTargetType,
	target: r.target,
	requirement: r.requirement === "signed_in" ? "signed_in" : "entitlement",
	entitlement: r.entitlement,
	freeDateField: r.free_date_field,
	freeHours: r.free_hours,
	freeFlagField: r.free_flag_field,
	dripDays: r.drip_days,
	lockedView: r.locked_view === "redirect" ? "redirect" : "teaser",
	teaserBlocks: r.teaser_blocks,
	redirectTo: r.redirect_to,
	priority: r.priority,
	active: !!r.active,
});

const cache = new WeakMap<Db, { at: number; rules: AccessRule[] }>();
const CACHE_MS = 30_000;

export async function listRules(db: Db, opts: { activeOnly?: boolean; fresh?: boolean } = {}): Promise<AccessRule[]> {
	await ensureSchema(db);
	const hit = cache.get(db);
	if (!opts.fresh && opts.activeOnly && hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
	const { results } = await db.prepare(`SELECT * FROM mbr_access_rules ORDER BY priority DESC, created_at`).all<RuleRow>();
	const all = results.map(toRule);
	const active = all.filter((r) => r.active);
	cache.set(db, { at: Date.now(), rules: active });
	return opts.activeOnly ? active : all;
}

export type RuleInput = Partial<Omit<AccessRule, "id">> & Pick<AccessRule, "name" | "targetType" | "target"> & { id?: string };

export type SaveRuleResult = { ok: true; rule: AccessRule } | { ok: false; reason: "invalid_name" | "invalid_target" | "entitlement_required" | "invalid_redirect" };

export async function saveRule(db: Db, input: RuleInput, now = Date.now()): Promise<SaveRuleResult> {
	await ensureSchema(db);
	const name = input.name.trim();
	if (!name || name.length > 120) return { ok: false, reason: "invalid_name" };
	const target = input.target.trim();
	const validTarget =
		input.targetType === "collection"
			? /^[a-z0-9_-]+$/i.test(target)
			: input.targetType === "term"
				? /^[a-z0-9_-]+:[a-z0-9_-]+$/i.test(target)
				: input.targetType === "entry"
					? /^[a-z0-9_-]+\/[^/\s]+$/i.test(target)
					: input.targetType === "path"
						? target.startsWith("/")
						: false;
	if (!validTarget) return { ok: false, reason: "invalid_target" };
	const requirement = input.requirement ?? "entitlement";
	const entitlement = input.entitlement?.trim() || null;
	if (requirement === "entitlement" && !entitlement) return { ok: false, reason: "entitlement_required" };
	const lockedView = input.lockedView ?? "teaser";
	const redirectTo = input.redirectTo?.trim() || null;
	if (lockedView === "redirect" && !(redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//"))) return { ok: false, reason: "invalid_redirect" };
	const id = input.id ?? `rule_${crypto.randomUUID()}`;
	const int = (v: number | undefined, d = 0) => Math.max(0, Math.floor(Number.isFinite(v) ? (v as number) : d));
	await db
		.prepare(
			`INSERT INTO mbr_access_rules (id, name, target_type, target, requirement, entitlement, free_date_field, free_hours, free_flag_field,
				drip_days, locked_view, teaser_blocks, redirect_to, priority, active, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
			 ON CONFLICT (id) DO UPDATE SET name = excluded.name, target_type = excluded.target_type, target = excluded.target,
			   requirement = excluded.requirement, entitlement = excluded.entitlement, free_date_field = excluded.free_date_field,
			   free_hours = excluded.free_hours, free_flag_field = excluded.free_flag_field, drip_days = excluded.drip_days,
			   locked_view = excluded.locked_view, teaser_blocks = excluded.teaser_blocks, redirect_to = excluded.redirect_to,
			   priority = excluded.priority, active = excluded.active, updated_at = excluded.updated_at`,
		)
		.bind(
			id,
			name,
			input.targetType,
			target,
			requirement,
			requirement === "entitlement" ? entitlement : null,
			input.freeDateField?.trim() || null,
			int(input.freeHours),
			input.freeFlagField?.trim() || null,
			int(input.dripDays),
			lockedView,
			int(input.teaserBlocks, 2),
			lockedView === "redirect" ? redirectTo : null,
			Math.floor(input.priority ?? 0),
			input.active === false ? 0 : 1,
			now,
		)
		.run();
	cache.delete(db);
	return { ok: true, rule: (await listRules(db, { fresh: true })).find((r) => r.id === id)! };
}

export async function deleteRule(db: Db, id: string): Promise<void> {
	await db.prepare(`DELETE FROM mbr_access_rules WHERE id = ?`).bind(id).run();
	cache.delete(db);
}

function pathMatches(pattern: string, path: string): boolean {
	const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
	return re.test(path);
}

/** True when a rule applies to this content. */
export function ruleMatches(rule: AccessRule, c: ContentContext): boolean {
	switch (rule.targetType) {
		case "collection":
			return !!c.collection && rule.target === c.collection;
		case "term":
			return !!c.terms?.includes(rule.target);
		case "entry": {
			const [col, key] = rule.target.split("/", 2);
			return col === c.collection && (key === c.slug || key === c.id);
		}
		case "path":
			return !!c.path && pathMatches(rule.target, c.path);
	}
}

/** The rule that governs this content: the most specific match, then the highest priority. */
export function governingRule(rules: readonly AccessRule[], c: ContentContext): AccessRule | null {
	let best: AccessRule | null = null;
	for (const r of rules) {
		if (!r.active || !ruleMatches(r, c)) continue;
		if (!best || SPECIFICITY[r.targetType] > SPECIFICITY[best.targetType] || (SPECIFICITY[r.targetType] === SPECIFICITY[best.targetType] && r.priority > best.priority)) {
			best = r;
		}
	}
	return best;
}

function toTime(v: unknown): number | null {
	if (v instanceof Date) return v.getTime();
	if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
	if (typeof v === "string" && v) {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

/** Decides access for one viewer and one piece of content (pure; see `checkAccess`). */
export function evaluateAccess(rules: readonly AccessRule[], member: AccessMember | null | undefined, c: ContentContext, now = Date.now()): AccessDecision {
	const rule = governingRule(rules, c);
	const base = { rule, view: null, teaserBlocks: 0, redirectTo: null, requires: null, freeUntil: null, availableAt: null } as const;
	if (!rule) return { ...base, allowed: true, reason: "no_rule" };
	const locked = (reason: AccessReason, extra: Partial<AccessDecision> = {}): AccessDecision => ({
		...base,
		allowed: false,
		reason,
		view: rule.lockedView,
		teaserBlocks: rule.teaserBlocks,
		redirectTo: rule.redirectTo,
		requires: rule.requirement === "entitlement" ? rule.entitlement : null,
		...extra,
	});
	if (rule.freeFlagField && c.fields?.[rule.freeFlagField] === true) return { ...base, allowed: true, reason: "free_flag" };
	if (rule.freeDateField && rule.freeHours > 0) {
		const start = toTime(c.fields?.[rule.freeDateField]);
		if (start !== null && start <= now && now < start + rule.freeHours * HOUR) return { ...base, allowed: true, reason: "free_window", freeUntil: start + rule.freeHours * HOUR };
	}
	if (rule.requirement === "signed_in") return member ? { ...base, allowed: true, reason: "signed_in" } : locked("sign_in_required");
	if (!member || !can(member, rule.entitlement!)) return locked("locked");
	if (rule.dripDays > 0 && member.createdAt) {
		const at = member.createdAt + rule.dripDays * DAY;
		if (now < at) return locked("drip", { availableAt: at });
	}
	return { ...base, allowed: true, reason: "entitled" };
}

/** Loads the active rules (cached briefly) and decides. */
export async function checkAccess(db: Db, member: AccessMember | null | undefined, c: ContentContext, now = Date.now()): Promise<AccessDecision> {
	return evaluateAccess(await listRules(db, { activeOnly: true }), member, c, now);
}

/** The first `n` Portable Text blocks (or array items) for a teaser. */
export function teaser<T>(blocks: readonly T[] | null | undefined, n: number): T[] {
	return (blocks ?? []).slice(0, Math.max(0, n));
}

/**
 * Structured data for a gated page, so search engines know the paywall is
 * legitimate (not cloaking). Merge it into your Article JSON-LD.
 * `cssSelector` points at the element that holds the gated part.
 */
export function paywallJsonLd(decision: Pick<AccessDecision, "allowed">, cssSelector = ".paywalled"): Record<string, unknown> {
	if (decision.allowed) return { isAccessibleForFree: true };
	return { isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector } };
}
