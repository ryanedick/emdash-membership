/**
 * Members admin, rendered as EmDash Block Kit. Every page and button routes
 * through `handleAdmin`. Action ids are `area:verb[:id]`.
 */
import { deleteMember, getMemberDetail, listMembers, memberStats, signOutEverywhere } from "../admin.ts";
import { grantProTime, revokeGrant } from "../grants.ts";
import type { Db } from "../db.ts";
import { listEarlyMembers } from "../launch.ts";
import type { PluginOptions } from "./options.ts";

type Block = Record<string, unknown>;
export interface AdminResponse {
	blocks: Block[];
	toast?: { type: "success" | "error" | "info"; message: string };
}
interface Interaction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
interface Ctx {
	db: Db;
	options: PluginOptions;
	now: number;
}

const PAGE = 50;

const header = (text: string): Block => ({ type: "header", text });
const context = (text: string): Block => ({ type: "context", text });
const button = (label: string, action_id: string, opts: { style?: "primary" | "danger" | "secondary"; value?: unknown; confirm?: { title: string; text: string; confirm: string } } = {}): Block => ({
	type: "button",
	label,
	action_id,
	...(opts.style && { style: opts.style }),
	...(opts.value !== undefined && { value: opts.value }),
	...(opts.confirm && { confirm: { ...opts.confirm, deny: "Cancel", ...(opts.style === "danger" && { style: "danger" }) } }),
});
const actions = (...elements: Block[]): Block => ({ type: "actions", elements });
const banner = (title: string, description?: string, variant: "default" | "alert" | "error" = "default"): Block => ({ type: "banner", title, ...(description && { description }), variant });
const text = (action_id: string, label: string, initial?: string | null, extra: Record<string, unknown> = {}): Block => ({ type: "text_input", action_id, label, ...(initial ? { initial_value: initial } : {}), ...extra });
const select = (action_id: string, label: string, options: { label: string; value: string }[], initial?: string | null): Block => ({ type: "select", action_id, label, options, ...(initial ? { initial_value: initial } : {}) });
const toggle = (action_id: string, label: string, initial: boolean): Block => ({ type: "toggle", action_id, label, initial_value: initial });
const num = (action_id: string, label: string, initial: number, min?: number, max?: number): Block => ({ type: "number_input", action_id, label, initial_value: initial, ...(min !== undefined && { min }), ...(max !== undefined && { max }) });
const form = (block_id: string, fields: Block[], submit: string, action_id: string): Block => ({ type: "form", block_id, fields, submit: { label: submit, action_id } });
const nav = (label: string, page: string, style: "primary" | "secondary" = "secondary"): Block => ({ type: "link", label, target: { kind: "plugin-page", path: page }, appearance: style });

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
const bool = (v: unknown) => v === true || v === "true" || v === "on" || v === 1;
const n = (x: number) => x.toLocaleString("en-US");
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");
const when = (ms: number | null | undefined) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");
function money(minor: number, currency = "USD") {
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`;
	}
}
const pro = (o: PluginOptions) => ({ proStatuses: o.proStatuses });

// ─────────────────────────────── pages ───────────────────────────────

async function overviewPage(c: Ctx): Promise<AdminResponse> {
	const s = await memberStats(c.db, { ...pro(c.options), planValues: c.options.planValues, now: c.now });
	const plans = Object.entries(s.byLookupKey);
	return {
		blocks: [
			header("Members"),
			{
				type: "stats",
				items: [
					{ label: "Members", value: n(s.total), description: `${n(s.new30d)} new in 30 days` },
					{ label: "Pro", value: n(s.pro), description: `${n(s.free)} on Free` },
					{ label: "Paying subscriptions", value: n(s.subscriptions), description: s.canceling ? `${n(s.canceling)} canceling` : "None canceling" },
					s.mrr === null
						? { label: "Signed in (30 days)", value: n(s.active30d) }
						: { label: "MRR (list price)", value: money(s.mrr, c.options.currency), description: "Before coupons and refunds" },
				],
			},
			{ type: "chart", config: { chart_type: "timeseries", style: "bar", series: [{ name: "New members", data: s.growth }], height: 200 } },
			...(s.pastDue ? [banner(`${n(s.pastDue)} subscription${s.pastDue === 1 ? "" : "s"} past due`, "Stripe is retrying the payment. They keep Pro until Stripe gives up.", "alert")] : []),
			{
				type: "fields",
				fields: [
					{ label: "Early members", value: n(s.earlyMembers) },
					{ label: "Pro through comp time only", value: n(s.compOnly) },
					{ label: "Signed in (30 days)", value: n(s.active30d) },
					...plans.map(([k, v]) => ({ label: `Subscriptions: ${k || "unknown price"}`, value: n(v) })),
				],
			},
			actions(nav("All members", "/members", "primary"), nav("Pro members", "/members?plan=pro"), nav("Early members", "/early")),
		],
	};
}

async function widget(c: Ctx): Promise<AdminResponse> {
	const s = await memberStats(c.db, { ...pro(c.options), planValues: c.options.planValues, now: c.now });
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Members", value: n(s.total) },
					{ label: "Pro", value: n(s.pro) },
					s.mrr === null ? { label: "New (30d)", value: n(s.new30d) } : { label: "MRR", value: money(s.mrr, c.options.currency) },
				],
			},
			actions(nav("Open members", "/", "primary")),
		],
	};
}

interface Filter {
	search?: string;
	plan?: string;
	early?: boolean;
	offset?: number;
}

function filterFromPage(page: string): Filter {
	const q = page.includes("?") ? new URLSearchParams(page.slice(page.indexOf("?") + 1)) : null;
	return q ? { search: q.get("q") ?? undefined, plan: q.get("plan") ?? undefined, early: q.get("early") === "1" } : {};
}

async function membersPage(c: Ctx, f: Filter = {}, extra: Block[] = []): Promise<AdminResponse> {
	const offset = f.offset ?? 0;
	const plan = f.plan === "pro" || f.plan === "free" ? f.plan : undefined;
	const { items, total } = await listMembers(c.db, { search: f.search, plan, earlyOnly: f.early, limit: PAGE, offset });
	return {
		blocks: [
			header("All members"),
			...extra,
			form(
				"filter",
				[
					text("search", "Search email", f.search),
					select("plan", "Plan", [{ label: "Any", value: "" }, { label: "Pro", value: "pro" }, { label: "Free", value: "free" }], plan ?? ""),
					toggle("early", "Early members only", !!f.early),
				],
				"Filter",
				"members:search",
			),
			context(`${n(total)} matching · showing ${total ? offset + 1 : 0}–${Math.min(offset + PAGE, total)}`),
			{
				type: "table",
				page_action_id: "members:page",
				empty_text: "No members match.",
				columns: [
					{ key: "email", label: "Email" },
					{ key: "plan", label: "Plan", format: "badge" },
					{ key: "billing", label: "Billing" },
					{ key: "joined", label: "Joined", format: "relative_time" },
					{ key: "seen", label: "Last sign-in", format: "relative_time" },
					{ key: "open", label: "", format: "element" },
				],
				rows: items.map((m) => ({
					email: m.email,
					plan: m.plan,
					billing: [m.subscriptionStatus ? `subscription ${m.subscriptionStatus}` : "", m.earlyMember ? "early member" : ""].filter(Boolean).join(" · "),
					joined: iso(m.createdAt),
					seen: iso(m.lastLoginAt),
					open: button("Open", "member:open", { value: m.id }),
				})),
				...(offset + PAGE < total ? { next_cursor: JSON.stringify({ ...f, offset: offset + PAGE }) } : {}),
			},
			header("Give someone Pro time"),
			context("Works for any email address. If they've never signed in, a Free member is created and upgraded; they get Pro as soon as they sign in."),
			grantForm("member:grant-email", true),
		],
	};
}

function grantForm(action_id: string, withEmail: boolean): Block {
	return form(
		"grant",
		[...(withEmail ? [text("email", "Email")] : []), num("days", "Days of Pro", 30, 1, 3650), text("reason", "Reason (shown in the member's history)", "", { placeholder: "Giveaway, support credit…" })],
		"Give Pro time",
		action_id,
	);
}

async function memberPage(c: Ctx, id: string): Promise<AdminResponse> {
	const d = await getMemberDetail(c.db, id, c.now);
	if (!d) return { ...(await membersPage(c)), toast: { type: "error", message: "Member not found" } };
	const m = d.member;
	const stripeBase = (c.options.stripeDashboardUrl ?? "https://dashboard.stripe.com").replace(/\/$/, "");
	const why = [
		d.subscriptions.some((s) => (c.options.proStatuses ?? ["active", "trialing", "past_due"]).includes(s.status)) && "a subscription",
		d.earlyAccessAt && !d.earlyAccessRevokedAt && (!d.graceEndsAt || d.graceEndsAt > c.now) && "early access",
		d.grants.some((g) => !g.revokedAt && g.endsAt > c.now) && "comp time",
	].filter(Boolean);
	return {
		blocks: [
			header(m.email),
			...(d.riskFlag ? [banner("Payment risk flagged by Stripe", `${d.riskFlag}. Check the customer in Stripe before giving them anything.`, "error")] : []),
			{
				type: "fields",
				fields: [
					{ label: "Plan", value: m.plan === "pro" ? `Pro${why.length ? ` (${why.join(", ")})` : ""}` : "Free" },
					{ label: "Joined", value: when(m.createdAt) },
					{ label: "Last sign-in", value: when(m.lastLoginAt) },
					{ label: "Signed-in devices", value: n(d.activeSessions) },
					{ label: "Early member", value: d.earlyMember ? `Yes, since ${when(d.earlyAccessAt)}${d.earlyAccessRevokedAt ? ` (refunded ${when(d.earlyAccessRevokedAt)})` : ""}` : "No" },
					...(d.graceEndsAt ? [{ label: "Grace period ends", value: when(d.graceEndsAt) }] : []),
					{ label: "Stripe customer", value: d.stripeCustomerId ? `[${d.stripeCustomerId}](${stripeBase}/customers/${d.stripeCustomerId})` : "—" },
				],
			},
			header("Subscriptions"),
			d.subscriptions.length
				? {
						type: "table",
						columns: [
							{ key: "status", label: "Status", format: "badge" },
							{ key: "price", label: "Price" },
							{ key: "renews", label: "Period ends" },
							{ key: "cancel", label: "" },
						],
						rows: d.subscriptions.map((s) => ({
							status: s.status,
							price: s.lookupKey ?? "",
							renews: when(s.currentPeriodEnd),
							cancel: s.cancelAtPeriodEnd ? "Cancels at period end" : "",
						})),
					}
				: context("No subscriptions. Changes to billing happen in Stripe and arrive here by webhook."),
			header("Comp Pro time"),
			d.grants.length
				? {
						type: "table",
						columns: [
							{ key: "reason", label: "Reason" },
							{ key: "period", label: "Period" },
							{ key: "state", label: "State", format: "badge" },
							{ key: "revoke", label: "", format: "element" },
						],
						rows: d.grants.map((g) => {
							const state = g.revokedAt ? "revoked" : g.endsAt <= c.now ? "ended" : g.startsAt > c.now ? "queued" : "active";
							return {
								reason: g.reason ?? g.key,
								period: `${when(g.startsAt)} → ${when(g.endsAt)}`,
								state,
								revoke:
									state === "active" || state === "queued"
										? button("Revoke", `grant:revoke:${m.id}`, { value: g.key, confirm: { title: "Revoke this Pro time?", text: "It ends now. Stacked grants after it keep their dates.", confirm: "Revoke" } })
										: "",
							};
						}),
					}
				: context("No comp time."),
			grantForm(`member:grant:${m.id}`, false),
			actions(
				button("Sign out everywhere", `member:signout:${m.id}`, { confirm: { title: "Sign this member out on every device?", text: "They'll need a new sign-in link.", confirm: "Sign out" } }),
				button("Delete member", `member:delete:${m.id}`, {
					style: "danger",
					confirm: { title: "Erase this member?", text: "Removes their account, sessions, comp time and billing records here. Their Stripe customer isn't touched. This can't be undone.", confirm: "Erase" },
				}),
				nav("Back to members", "/members"),
			),
		],
	};
}

async function earlyPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const list = await listEarlyMembers(c.db, pro(c.options));
	const active = list.filter((e) => !e.refunded);
	return {
		blocks: [
			header("Early members"),
			context("Everyone who bought early access. The badge is permanent, even after a refund or a downgrade."),
			{
				type: "stats",
				items: [
					{ label: "Early members", value: n(active.length), description: `${n(list.length - active.length)} refunded` },
					{ label: "Now subscribed", value: n(active.filter((e) => e.subscribed).length) },
					{ label: "On Pro", value: n(active.filter((e) => e.plan === "pro").length) },
				],
			},
			...extra,
			{
				type: "table",
				empty_text: "No early members yet.",
				columns: [
					{ key: "email", label: "Email" },
					{ key: "since", label: "Since", format: "relative_time" },
					{ key: "plan", label: "Plan", format: "badge" },
					{ key: "state", label: "" },
					{ key: "open", label: "", format: "element" },
				],
				rows: list.map((e) => ({
					email: e.email,
					since: iso(e.earlyMemberSince),
					plan: e.plan,
					state: e.refunded ? "refunded" : e.subscribed ? "subscribed" : "",
					open: button("Open", "member:open", { value: e.memberId }),
				})),
			},
			actions(button("Export CSV", "early:export")),
		],
	};
}

function csvCell(v: unknown) {
	const s = v === null || v === undefined ? "" : String(v);
	return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─────────────────────────────── actions ───────────────────────────────

async function act(c: Ctx, i: Interaction): Promise<AdminResponse> {
	const [area, verb, ...rest] = (i.action_id ?? "").split(":");
	const id = rest.join(":") || (typeof i.value === "string" ? i.value : "");
	const v = i.values ?? {};
	const ok = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "success", message } });
	const fail = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "error", message } });
	const proOpts = pro(c.options);

	if (area === "members" && verb === "search") return membersPage(c, { search: str(v.search), plan: str(v.plan), early: bool(v.early) });
	if (area === "members" && verb === "page") {
		const raw = (i.value as { cursor?: string } | string | undefined) ?? "";
		const cursor = typeof raw === "string" ? raw : (raw.cursor ?? "");
		let f: Filter = {};
		try {
			f = JSON.parse(cursor) as Filter;
		} catch {
			/* first page */
		}
		return membersPage(c, f);
	}
	if (area === "early" && verb === "export") {
		const list = await listEarlyMembers(c.db, proOpts);
		const csv = [
			"email,early_member_since,plan,subscribed,refunded",
			...list.map((e) => [e.email, iso(e.earlyMemberSince), e.plan, e.subscribed, e.refunded].map(csvCell).join(",")),
		].join("\n");
		return earlyPage(c, [{ type: "accordion", label: "CSV export (copy it)", default_open: true, blocks: [{ type: "code", code: csv, language: "bash" }] }]);
	}
	if (area === "grant" && verb === "revoke") {
		const key = typeof i.value === "string" ? i.value : "";
		const g = key ? await revokeGrant(c.db, key, { ...proOpts, now: c.now }) : null;
		return g ? ok(await memberPage(c, id), "Pro time revoked") : fail(await memberPage(c, id), "Grant not found");
	}
	if (area === "member") {
		switch (verb) {
			case "open":
				return memberPage(c, id);
			case "grant":
			case "grant-email": {
				const days = Number(v.days);
				let email = str(v.email);
				if (verb === "grant") {
					const d = await getMemberDetail(c.db, id, c.now);
					if (!d) return fail(await membersPage(c), "Member not found");
					email = d.member.email;
				}
				const back = async (memberId?: string) => (memberId ? memberPage(c, memberId) : membersPage(c));
				if (!Number.isFinite(days) || days <= 0) return fail(await back(verb === "grant" ? id : undefined), "Enter a number of days above zero.");
				const r = await grantProTime(c.db, {
					email,
					days,
					key: `admin:${crypto.randomUUID()}`,
					reason: str(v.reason) || "Given by staff",
					...proOpts,
					now: c.now,
				});
				if (!r.ok) return fail(await back(verb === "grant" ? id : undefined), r.reason === "invalid_email" ? "That email address isn't valid." : "Enter a number of days above zero.");
				return ok(await memberPage(c, r.grant.memberId), `Gave ${days} day${days === 1 ? "" : "s"} of Pro, until ${when(r.grant.endsAt)}`);
			}
			case "signout": {
				const ended = await signOutEverywhere(c.db, id);
				return ok(await memberPage(c, id), `Ended ${ended} session${ended === 1 ? "" : "s"}`);
			}
			case "delete": {
				const r = await deleteMember(c.db, id, proOpts);
				if (r.ok) return ok(await membersPage(c), `Erased ${r.email}`);
				return fail(
					r.reason === "not_found" ? await membersPage(c) : await memberPage(c, id),
					r.reason === "has_subscription" ? "Cancel their subscription in Stripe first; the next webhook needs the member." : "Member not found",
				);
			}
		}
	}
	return renderPage(c, i.page ?? "/");
}

async function renderPage(c: Ctx, page: string): Promise<AdminResponse> {
	if (page.startsWith("widget") || page === "members-overview") return widget(c);
	const path = page.split("?")[0].replace(/\/$/, "") || "/";
	switch (path) {
		case "/":
			return overviewPage(c);
		case "/members":
			return membersPage(c, filterFromPage(page));
		case "/early":
			return earlyPage(c);
		default:
			return overviewPage(c);
	}
}

export async function handleAdmin(db: Db, input: unknown, options: PluginOptions = {}, now = Date.now()): Promise<AdminResponse> {
	const i = (input ?? {}) as Interaction;
	const c: Ctx = { db, options, now };
	try {
		if (i.type === "page_load") return await renderPage(c, i.page ?? "/");
		if (i.type === "block_action" || i.type === "form_submit") return await act(c, i);
		return await renderPage(c, "/");
	} catch (err) {
		const message = (err as Error)?.message ?? "Something went wrong";
		let fallback: AdminResponse;
		try {
			fallback = await renderPage(c, i.page ?? "/");
		} catch {
			fallback = { blocks: [banner("Members couldn't load", message, "error")] };
		}
		return { ...fallback, toast: { type: "error", message } };
	}
}
