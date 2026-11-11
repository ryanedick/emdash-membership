/**
 * Members admin, continued: access rules, teams, gifts, downloads, settings
 * (profile fields, cancel flow, webhooks), import/export, and the extra
 * sections on a member's page (timeline, notes, audit, Stripe link).
 */
import { downloadStats, deleteDownload, listDownloads, saveDownload } from "../downloads.ts";
import { addNote, createWebhook, deleteNote, deleteWebhook, EVENT_TYPES, listAudit, listDeliveries, listEvents, listNotes, listWebhooks, setWebhookActive } from "../events.ts";
import { createCompGift, listGifts } from "../gifts.ts";
import { listPlans } from "../plans.ts";
import { deleteProfileField, listProfileFields, type ProfileFieldType, saveProfileField } from "../profile.ts";
import { cancellationReport, getCancelFlow, type SaveOffer, saveCancelFlow } from "../retention.ts";
import { deleteRule, listRules, type RuleTargetType, saveRule } from "../rules.ts";
import { createCompTeam, getTeam, inviteToTeam, listSeats, listTeams, removeFromTeam, seatsInUse, setJoinDomain } from "../teams.ts";
import { bulkGrant, exportMembersCsv, importMembersCsv } from "../transfer.ts";
import {
	type AdminResponse,
	actions,
	banner,
	billingOf,
	type Block,
	bool,
	button,
	context,
	type Ctx,
	divider,
	form,
	header,
	type Interaction,
	iso,
	list,
	n,
	nav,
	num,
	select,
	str,
	text,
	toggle,
	when,
} from "./blocks.ts";

const ok = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "success", message } });
const fail = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "error", message } });
const code = (s: string): Block => ({ type: "code", code: s, language: "bash" });

async function paidPlanOptions(c: Ctx) {
	return (await listPlans(c.db)).filter((p) => p.paid).map((p) => ({ label: p.name, value: p.id }));
}

// ─────────────────────────────── access rules ───────────────────────────────

const TARGET_HELP: Record<RuleTargetType, string> = {
	collection: "a collection slug, e.g. tips",
	term: "taxonomy:term, e.g. category:prompting",
	entry: "collection/slug, e.g. tips/welcome",
	path: "a path, * matches anything, e.g. /courses/*",
};

function ruleFields(r?: Awaited<ReturnType<typeof listRules>>[number]): Block[] {
	return [
		text("name", "Name", r?.name, { placeholder: "Tips archive" }),
		select("target_type", "Applies to", (Object.keys(TARGET_HELP) as RuleTargetType[]).map((k) => ({ label: `${k}: ${TARGET_HELP[k]}`, value: k })), r?.targetType ?? "collection"),
		text("target", "Target", r?.target, { placeholder: "tips" }),
		select("requirement", "Requires", [
			{ label: "An entitlement", value: "entitlement" },
			{ label: "Just being signed in", value: "signed_in" },
		], r?.requirement ?? "entitlement"),
		text("entitlement", "Entitlement", r?.entitlement ?? "pro"),
		text("free_date_field", "Free window: date field (optional)", r?.freeDateField, { placeholder: "issue_date" }),
		num("free_hours", "Free window: hours after that date", r?.freeHours ?? 0, 0, 100_000),
		text("free_flag_field", "Always free when this boolean field is true (optional)", r?.freeFlagField, { placeholder: "free_override" }),
		num("drip_days", "Drip: days after joining before members see it", r?.dripDays ?? 0, 0, 3650),
		select("locked_view", "When locked", [
			{ label: "Show a teaser and the paywall", value: "teaser" },
			{ label: "Redirect", value: "redirect" },
		], r?.lockedView ?? "teaser"),
		num("teaser_blocks", "Teaser length (blocks)", r?.teaserBlocks ?? 2, 0, 50),
		text("redirect_to", "Redirect to (if redirecting)", r?.redirectTo, { placeholder: "/pricing" }),
		num("priority", "Priority (higher wins among equally specific rules)", r?.priority ?? 0, -1000, 1000),
		toggle("active", "Active", r?.active ?? true),
	];
}

export async function accessPage(c: Ctx, editId?: string, extra: Block[] = []): Promise<AdminResponse> {
	const rules = await listRules(c.db);
	const editing = editId ? rules.find((r) => r.id === editId) : undefined;
	return {
		blocks: [
			header("Access rules"),
			context("What each piece of content needs. The most specific rule wins (entry, then term, then collection, then path). Pages ask with `members.access(Astro, { collection, slug, terms, fields })`; content with no rule is open."),
			...extra,
			{
				type: "table",
				empty_text: "No rules yet: everything is open.",
				columns: [
					{ key: "name", label: "Rule" },
					{ key: "target", label: "Applies to" },
					{ key: "needs", label: "Needs" },
					{ key: "exceptions", label: "Exceptions" },
					{ key: "state", label: "", format: "badge" },
					{ key: "edit", label: "", format: "element" },
				],
				rows: rules.map((r) => ({
					name: r.name,
					target: `${r.targetType}: ${r.target}`,
					needs: r.requirement === "signed_in" ? "signed in" : r.entitlement,
					exceptions: [r.freeDateField && r.freeHours ? `free ${r.freeHours}h after ${r.freeDateField}` : "", r.freeFlagField ? `free when ${r.freeFlagField}` : "", r.dripDays ? `drip ${r.dripDays}d` : ""].filter(Boolean).join(" · ") || "—",
					state: r.active ? "active" : "off",
					edit: button("Edit", "rule:edit", { value: r.id }),
				})),
			},
			header(editing ? `Edit "${editing.name}"` : "New rule"),
			form("rule", ruleFields(editing), editing ? "Save rule" : "Add rule", editing ? `rule:save:${editing.id}` : "rule:save"),
			...(editing ? [actions(button("Delete rule", `rule:delete:${editing.id}`, { style: "danger", confirm: { title: "Delete this rule?", text: "Content it covered becomes open unless another rule applies.", confirm: "Delete" } }), nav("New rule", "/access"))] : []),
		],
	};
}

// ─────────────────────────────── teams ───────────────────────────────

export async function teamsPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const teams = await listTeams(c.db);
	const rows = [];
	for (const t of teams) {
		const owner = await c.db.prepare(`SELECT email FROM mbr_members WHERE id = ?`).bind(t.ownerMemberId).first<{ email: string }>();
		rows.push({
			name: t.name,
			owner: owner?.email ?? "—",
			plan: t.planId,
			seats: `${n(await seatsInUse(c.db, t.id))} / ${n(t.seats)}`,
			billing: t.subscriptionId ? "subscription" : "comp",
			state: t.status,
			open: button("Open", "team:open", { value: t.id }),
		});
	}
	return {
		blocks: [
			header("Teams"),
			context("Teams are bought with a per-seat price (mark a recurring price \"per seat\" on its plan), or made here for free. Every seat holder gets the team's plan."),
			...extra,
			{
				type: "table",
				empty_text: "No teams yet.",
				columns: [
					{ key: "name", label: "Team" },
					{ key: "owner", label: "Owner" },
					{ key: "plan", label: "Plan" },
					{ key: "seats", label: "Seats used" },
					{ key: "billing", label: "Billing" },
					{ key: "state", label: "", format: "badge" },
					{ key: "open", label: "", format: "element" },
				],
				rows,
			},
			header("Make a team (no charge)"),
			form(
				"comp-team",
				[text("name", "Team name"), text("owner", "Owner's email"), select("plan", "Plan", await paidPlanOptions(c)), num("seats", "Seats", 5, 1, 1000), text("domain", "Join domain (optional)", "", { placeholder: "partner.org" })],
				"Create team",
				"team:create",
			),
		],
	};
}

export async function teamPage(c: Ctx, id: string): Promise<AdminResponse> {
	const team = await getTeam(c.db, { id });
	if (!team) return fail(await teamsPage(c), "Team not found");
	const seats = await listSeats(c.db, id);
	return {
		blocks: [
			header(team.name),
			{
				type: "fields",
				fields: [
					{ label: "Plan", value: team.planId },
					{ label: "Seats", value: `${n(seats.length)} used of ${n(team.seats)}` },
					{ label: "Billing", value: team.subscriptionId ? `Subscription ${team.subscriptionId}` : "Comp (no charge)" },
					{ label: "Join domain", value: team.joinDomain ?? "—" },
					{ label: "Status", value: team.status },
				],
			},
			{
				type: "table",
				columns: [
					{ key: "email", label: "Email" },
					{ key: "role", label: "Role" },
					{ key: "state", label: "", format: "badge" },
					{ key: "joined", label: "Joined", format: "relative_time" },
					{ key: "remove", label: "", format: "element" },
				],
				rows: seats.map((s) => ({
					email: s.email,
					role: s.role,
					state: s.status,
					joined: iso(s.joinedAt),
					remove: s.memberId === team.ownerMemberId ? "" : button("Remove", `team:remove:${id}`, { value: s.email, confirm: { title: `Remove ${s.email}?`, text: "They lose the team's plan now.", confirm: "Remove" } }),
				})),
			},
			form("invite", [text("email", "Invite by email")], "Send invite", `team:invite:${id}`),
			form("domain", [text("domain", "Join domain (blank to clear)", team.joinDomain)], "Save domain", `team:domain:${id}`),
			...(team.subscriptionId && c.stripe ? [form("seats", [num("seats", "Seats (prorated in Stripe)", team.seats, 1, 1000)], "Change seats", `team:seats:${id}`)] : []),
			actions(nav("All teams", "/teams")),
		],
	};
}

// ─────────────────────────────── gifts ───────────────────────────────

export async function giftsPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const gifts = await listGifts(c.db, { limit: 200 });
	return {
		blocks: [
			header("Gifts"),
			context("Sold with a gift price (a one-time price with \"gift days\" on its plan), or made here for giveaways. Each code works once."),
			...extra,
			{
				type: "table",
				empty_text: "No gifts yet.",
				columns: [
					{ key: "code", label: "Code" },
					{ key: "what", label: "Gift" },
					{ key: "from", label: "From" },
					{ key: "to", label: "To" },
					{ key: "state", label: "", format: "badge" },
					{ key: "at", label: "Created", format: "relative_time" },
				],
				rows: gifts.map((g) => ({ code: g.code, what: `${g.days} days of ${g.planId}`, from: g.buyerEmail, to: g.recipientEmail ?? "—", state: g.status, at: iso(g.createdAt) })),
			},
			header("Make a gift code (no charge)"),
			form("comp-gift", [select("plan", "Plan", await paidPlanOptions(c)), num("days", "Days", 30, 1, 3650), text("note", "Note (e.g. Podcast giveaway)")], "Create code", "gift:create"),
		],
	};
}

// ─────────────────────────────── downloads ───────────────────────────────

export async function downloadsPage(c: Ctx, editId?: string, extra: Block[] = []): Promise<AdminResponse> {
	const [items, stats] = await Promise.all([listDownloads(c.db), downloadStats(c.db)]);
	const editing = editId ? items.find((d) => d.id === editId) : undefined;
	return {
		blocks: [
			header("Downloads"),
			context("Files in your R2 bucket, served only to members with the entitlement. Mount the route with `members.downloadRoute({ bucket })`; links are /download/<id>."),
			...extra,
			{
				type: "table",
				empty_text: "No downloads yet.",
				columns: [
					{ key: "title", label: "Title" },
					{ key: "file", label: "File" },
					{ key: "needs", label: "Needs" },
					{ key: "limit", label: "Limit" },
					{ key: "count", label: "Downloads" },
					{ key: "edit", label: "", format: "element" },
				],
				rows: items.map((d) => ({
					title: `${d.title}${d.active ? "" : " (hidden)"}`,
					file: d.r2Key,
					needs: d.entitlement ?? "signed in",
					limit: d.limitPerMember ? `${d.limitPerMember} each` : "—",
					count: `${n(stats.get(d.id)?.total ?? 0)} by ${n(stats.get(d.id)?.members ?? 0)}`,
					edit: button("Edit", "download:edit", { value: d.id }),
				})),
			},
			header(editing ? `Edit "${editing.title}"` : "Add a download"),
			form(
				"download",
				[
					text("title", "Title", editing?.title),
					text("description", "Description", editing?.description),
					text("r2_key", "File key in the bucket", editing?.r2Key, { placeholder: "downloads/prompt-pack.pdf" }),
					text("filename", "Download file name (optional)", editing?.filename),
					text("entitlement", "Entitlement needed (blank = any signed-in member)", editing?.entitlement ?? "pro"),
					num("limit", "Downloads per member (0 = unlimited)", editing?.limitPerMember ?? 0, 0, 1000),
					num("sort", "Sort order", editing?.sortOrder ?? 0, 0, 10000),
					toggle("active", "Visible", editing?.active ?? true),
				],
				editing ? "Save" : "Add",
				editing ? `download:save:${editing.id}` : "download:save",
			),
			...(editing ? [actions(button("Delete", `download:delete:${editing.id}`, { style: "danger", confirm: { title: "Delete this download?", text: "The file stays in the bucket.", confirm: "Delete" } }), nav("Add another", "/downloads"))] : []),
		],
	};
}

// ─────────────────────────────── settings ───────────────────────────────

const FIELD_TYPES: { label: string; value: ProfileFieldType }[] = [
	{ label: "Short text", value: "text" },
	{ label: "Long text", value: "textarea" },
	{ label: "One choice", value: "select" },
	{ label: "Several choices", value: "multiselect" },
	{ label: "Checkbox", value: "checkbox" },
	{ label: "Link", value: "url" },
];

function offerText(o: SaveOffer | null) {
	return !o ? "" : o.type === "coupon" ? `coupon ${o.code}` : o.type === "pause" ? `pause ${o.months}` : `switch ${o.lookupKey}`;
}

function parseOffer(v: string): SaveOffer | null {
	const [kind, arg] = v.trim().split(/\s+/, 2);
	if (kind === "coupon" && arg) return { type: "coupon", code: arg };
	if (kind === "pause" && Number(arg) >= 1) return { type: "pause", months: Number(arg) };
	if (kind === "switch" && arg) return { type: "switch", lookupKey: arg };
	return null;
}

export async function settingsPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const [fields, flow, report, hooks] = await Promise.all([listProfileFields(c.db), getCancelFlow(c.db), cancellationReport(c.db, { now: c.now }), listWebhooks(c.db)]);
	const hookBlocks: Block[] = [];
	for (const h of hooks) {
		const recent = await listDeliveries(c.db, h.id, 5);
		hookBlocks.push({
			type: "accordion",
			label: `${h.url} (${h.active ? "on" : "off"}; ${h.events.length ? h.events.join(", ") : "all events"})`,
			blocks: [
				context(`Signing secret: \`${h.secret}\`. Each delivery has an \`X-Membership-Signature: t=…,v1=…\` header (HMAC-SHA256 of "t.body"); check it with \`verifyWebhookSignature\`.`),
				{
					type: "table",
					empty_text: "Nothing sent yet.",
					columns: [
						{ key: "event", label: "Event" },
						{ key: "state", label: "", format: "badge" },
						{ key: "detail", label: "" },
					],
					rows: recent.map((d) => ({ event: d.eventType, state: d.deliveredAt ? "delivered" : d.attempts ? "retrying" : "queued", detail: d.deliveredAt ? when(d.deliveredAt) : (d.lastError ?? "") })),
				},
				actions(button(h.active ? "Pause" : "Resume", `hook:toggle:${h.id}`), button("Delete", `hook:delete:${h.id}`, { style: "danger", confirm: { title: "Delete this webhook?", text: "Queued deliveries are dropped.", confirm: "Delete" } })),
			],
		});
	}
	return {
		blocks: [
			header("Settings"),
			...extra,
			header("Profile questions"),
			context("Asked on the account page, and at sign-up when \"ask at sign-up\" is on (with `onboarding: true` in membershipsAstro). Answers are in member pages and the CSV export."),
			{
				type: "table",
				empty_text: "No questions yet.",
				columns: [
					{ key: "key", label: "Key" },
					{ key: "label", label: "Question" },
					{ key: "type", label: "Type" },
					{ key: "flags", label: "" },
					{ key: "del", label: "", format: "element" },
				],
				rows: fields.map((f) => ({
					key: f.key,
					label: f.label,
					type: `${f.type}${f.options.length ? `: ${f.options.join(", ")}` : ""}`,
					flags: [f.required ? "required" : "", f.atSignup ? "at sign-up" : ""].filter(Boolean).join(" · "),
					del: button("Delete", `field:delete:${f.key}`, { style: "danger", confirm: { title: `Delete "${f.label}"?`, text: "Everyone's answers to it are deleted too.", confirm: "Delete" } }),
				})),
			},
			form(
				"field",
				[
					text("key", "Key (lowercase, e.g. tools)"),
					text("label", "Question"),
					select("type", "Type", FIELD_TYPES, "text"),
					text("options", "Choices (comma-separated, for choice types)"),
					toggle("required", "Required", false),
					toggle("signup", "Ask at sign-up", false),
					num("sort", "Sort order", 0, 0, 1000),
				],
				"Add or update question",
				"field:save",
			),
			divider,
			header("Cancel flow"),
			context(`Members choose a reason when they cancel. An offer is shown first: "coupon CODE" (an active coupon), "pause N" (months), or "switch lookup_key" (another recurring price). Leave it blank for none.`),
			form(
				"flow",
				[
					...flow.reasons.flatMap((r, i) => [text(`label_${i}`, `Reason ${i + 1}`, r.label), text(`offer_${i}`, `Offer for reason ${i + 1}`, offerText(r.offer))]),
					text(`label_${flow.reasons.length}`, "New reason (optional)"),
					text(`offer_${flow.reasons.length}`, "Offer for the new reason"),
					toggle("comment", "Ask for a comment", flow.askComment),
				],
				"Save cancel flow",
				"flow:save",
			),
			{
				type: "fields",
				fields: [
					{ label: `Cancel attempts (${report.days} days)`, value: n(report.total) },
					{ label: "Canceled", value: n(report.outcomes.canceled) },
					{ label: "Kept (coupon / pause / switch / changed mind)", value: `${n(report.outcomes.saved_coupon)} / ${n(report.outcomes.paused)} / ${n(report.outcomes.switched)} / ${n(report.outcomes.kept)}` },
					...report.byReason.map((r) => ({ label: r.label, value: `${n(r.count)} (${n(r.saved)} kept)` })),
				],
			},
			...(report.comments.length ? [{ type: "accordion", label: "Recent comments", blocks: report.comments.map((c2) => context(`${when(c2.at)} · ${c2.reason}: ${c2.comment}`)) }] : []),
			divider,
			header("Webhooks"),
			context(`Membership events posted to your URL as JSON, signed, retried for a day. Events: ${EVENT_TYPES.join(", ")}.`),
			...hookBlocks,
			form("hook", [text("url", "Endpoint URL (https)"), text("events", "Events (comma-separated, blank = all)")], "Add webhook", "hook:create"),
		],
	};
}

// ─────────────────────────────── import / export ───────────────────────────────

export async function importPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	return {
		blocks: [
			header("Import & export"),
			...extra,
			header("Import members"),
			context(
				"Paste a CSV with an email column. Recognised columns: name, plan, days, tier/status/complimentary (marks paid rows), expiry, Stripe customer id, created date, and your profile question keys. Exports from most newsletter and membership tools work as they are. Run a dry run first.",
			),
			form(
				"import",
				[
					text("csv", "CSV", "", { multiline: true, placeholder: "email,plan,days\nada@example.com,pro,30" }),
					select("plan", "Plan for rows marked paid (without a plan column)", await paidPlanOptions(c)),
					num("days", "Days for paid rows without an expiry or days column (0 = none)", 0, 0, 3650),
					text("source", "Source (shown in member history)", "", { placeholder: "previous platform" }),
					toggle("dry", "Dry run (check only)", true),
				],
				"Import",
				"import:run",
			),
			header("Give time to many people"),
			form(
				"bulk",
				[text("emails", "Emails (one per line or comma-separated)", "", { multiline: true }), select("plan", "Plan", await paidPlanOptions(c)), num("days", "Days", 30, 1, 3650), text("reason", "Reason", "Thank you")],
				"Give time",
				"bulk:grant",
			),
			header("Export"),
			actions(button("Export all members", "export:all"), button("Export paid members", "export:paid")),
		],
	};
}

// ─────────────────────────────── member page extras ───────────────────────────────

export async function memberExtras(c: Ctx, memberId: string): Promise<Block[]> {
	const [events, notes, trail] = await Promise.all([listEvents(c.db, { memberId, limit: 20 }), listNotes(c.db, memberId), listAudit(c.db, { memberId, limit: 10 })]);
	return [
		header("Notes"),
		...notes.map((nt) => ({ type: "section", text: `${nt.body}\n_${nt.author ?? "staff"} · ${when(nt.createdAt)}_`, accessory: button("Delete", `note:delete:${memberId}`, { value: nt.id }) })),
		form("note", [text("body", "Add a note (staff only)", "", { multiline: true })], "Add note", `note:add:${memberId}`),
		...(c.stripe ? [form("link", [text("customer", "Link a Stripe customer (cus_…), e.g. after an import")], "Link and sync", `member:link:${memberId}`)] : []),
		header("Timeline"),
		{
			type: "table",
			empty_text: "No events yet.",
			columns: [
				{ key: "type", label: "Event" },
				{ key: "detail", label: "" },
				{ key: "at", label: "When", format: "relative_time" },
			],
			rows: events.map((e) => ({ type: e.type, detail: summarize(e.data), at: iso(e.createdAt) })),
		},
		...(trail.length ? [{ type: "accordion", label: "Staff actions", blocks: trail.map((a) => context(`${when(a.createdAt)} · ${a.actor ?? "staff"} · ${a.action}${a.detail ? ` · ${a.detail}` : ""}`)) }] : []),
	];
}

function summarize(d: Record<string, unknown>): string {
	const parts: string[] = [];
	if (Array.isArray(d.after)) parts.push(`plans: ${(d.after as string[]).join(", ") || "free"}`);
	for (const k of ["status", "plan", "price", "days", "teamId", "title", "source"]) if (d[k] != null && d[k] !== "") parts.push(`${k}: ${String(d[k])}`);
	return parts.join(" · ").slice(0, 160);
}

// ─────────────────────────────── actions ───────────────────────────────

/** Handles this module's actions; returns null when the action isn't one of them. */
export async function moreActions(c: Ctx, i: Interaction, memberPage: (id: string) => Promise<AdminResponse>): Promise<AdminResponse | null> {
	const [area, verb, ...rest] = (i.action_id ?? "").split(":");
	const id = rest.join(":") || (typeof i.value === "string" ? i.value : "");
	const v = i.values ?? {};
	switch (area) {
		case "rule": {
			if (verb === "edit") return accessPage(c, id);
			if (verb === "delete") {
				await deleteRule(c.db, id);
				return ok(await accessPage(c), "Rule deleted");
			}
			const r = await saveRule(
				c.db,
				{
					id: rest.length ? id : undefined,
					name: str(v.name),
					targetType: (str(v.target_type) || "collection") as RuleTargetType,
					target: str(v.target),
					requirement: str(v.requirement) === "signed_in" ? "signed_in" : "entitlement",
					entitlement: str(v.entitlement),
					freeDateField: str(v.free_date_field),
					freeHours: Number(v.free_hours) || 0,
					freeFlagField: str(v.free_flag_field),
					dripDays: Number(v.drip_days) || 0,
					lockedView: str(v.locked_view) === "redirect" ? "redirect" : "teaser",
					teaserBlocks: Number(v.teaser_blocks) || 0,
					redirectTo: str(v.redirect_to),
					priority: Number(v.priority) || 0,
					active: v.active === undefined ? true : bool(v.active),
				},
				c.now,
			);
			const msg = { invalid_name: "Give the rule a name.", invalid_target: "That target doesn't match the format for its type.", entitlement_required: "Enter the entitlement it needs.", invalid_redirect: "Redirects need a path on this site, like /pricing." };
			return r.ok ? ok(await accessPage(c, r.rule.id), "Rule saved") : fail(await accessPage(c, rest.length ? id : undefined), msg[r.reason]);
		}
		case "team": {
			if (verb === "open") return teamPage(c, id);
			if (verb === "create") {
				const email = str(v.owner).toLowerCase();
				const owner = await c.db.prepare(`SELECT id, email FROM mbr_members WHERE email = ?`).bind(email).first<{ id: string; email: string }>();
				if (!owner) return fail(await teamsPage(c), "The owner needs to have signed in once (or be given time first).");
				const t = await createCompTeam(c.db, { owner, planId: str(v.plan), seats: Number(v.seats) || 1, name: str(v.name), joinDomain: str(v.domain) || null, now: c.now });
				return t ? ok(await teamPage(c, t.id), "Team created") : fail(await teamsPage(c), "Pick a paid plan.");
			}
			if (verb === "invite") {
				const r = await inviteToTeam(c.db, id, str(v.email), { now: c.now });
				return r.ok ? ok(await teamPage(c, id), "Invitation sent") : fail(await teamPage(c, id), r.reason.replace(/_/g, " "));
			}
			if (verb === "remove") {
				const done = await removeFromTeam(c.db, id, typeof i.value === "string" ? i.value : "", { now: c.now });
				return done ? ok(await teamPage(c, id), "Removed") : fail(await teamPage(c, id), "Couldn't remove that seat");
			}
			if (verb === "domain") return (await setJoinDomain(c.db, id, str(v.domain) || null)) ? ok(await teamPage(c, id), "Saved") : fail(await teamPage(c, id), "That isn't a valid domain");
			if (verb === "seats") {
				const billing = billingOf(c);
				if (!billing) return fail(await teamPage(c, id), "Stripe isn't connected.");
				const r = await billing.updateTeamSeats(id, Number(v.seats) || 0);
				return r.ok ? ok(await teamPage(c, id), "Seats updated") : fail(await teamPage(c, id), r.error ?? r.reason);
			}
			return null;
		}
		case "gift": {
			if (verb !== "create") return null;
			const g = await createCompGift(c.db, { planId: str(v.plan), days: Number(v.days) || 0, note: str(v.note), now: c.now });
			return g ? ok(await giftsPage(c, [banner(`Gift code: ${g.code}`, `${g.days} days of ${g.planId}. Redeem at your gift page, e.g. /gift/redeem?code=${g.code}`)]), "Code created") : fail(await giftsPage(c), "Pick a paid plan and a number of days.");
		}
		case "download": {
			if (verb === "edit") return downloadsPage(c, id);
			if (verb === "delete") {
				await deleteDownload(c.db, id);
				return ok(await downloadsPage(c), "Deleted");
			}
			const r = await saveDownload(
				c.db,
				{
					id: rest.length ? id : undefined,
					title: str(v.title),
					description: str(v.description),
					r2Key: str(v.r2_key),
					filename: str(v.filename),
					entitlement: str(v.entitlement) || null,
					limitPerMember: Number(v.limit) || 0,
					sortOrder: Number(v.sort) || 0,
					active: v.active === undefined ? true : bool(v.active),
				},
				c.now,
			);
			return r.ok ? ok(await downloadsPage(c, r.download.id), "Saved") : fail(await downloadsPage(c), r.reason.replace(/_/g, " "));
		}
		case "field": {
			if (verb === "delete") {
				await deleteProfileField(c.db, id);
				return ok(await settingsPage(c), "Question deleted");
			}
			const r = await saveProfileField(
				c.db,
				{ key: str(v.key), label: str(v.label), type: (str(v.type) || "text") as ProfileFieldType, options: list(v.options), required: bool(v.required), atSignup: bool(v.signup), sortOrder: Number(v.sort) || 0 },
				c.now,
			);
			const msg = { invalid_key: "Keys are lowercase letters, numbers and _.", invalid_label: "Write the question.", invalid_type: "Pick a type.", options_required: "Choice questions need choices." };
			return r.ok ? ok(await settingsPage(c), "Question saved") : fail(await settingsPage(c), msg[r.reason]);
		}
		case "flow": {
			const reasons = [];
			for (let k = 0; k < 30; k++) {
				const label = str(v[`label_${k}`]);
				if (!label) continue;
				reasons.push({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `reason_${k}`, label, offer: parseOffer(str(v[`offer_${k}`])) });
			}
			await saveCancelFlow(c.db, { reasons, askComment: bool(v.comment) });
			return ok(await settingsPage(c), "Cancel flow saved");
		}
		case "hook": {
			if (verb === "create") {
				const r = await createWebhook(c.db, { url: str(v.url), events: list(v.events) }, c.now);
				return r.ok ? ok(await settingsPage(c), "Webhook added") : fail(await settingsPage(c), r.reason === "invalid_url" ? "Use an https URL." : "Unknown event type.");
			}
			if (verb === "toggle") {
				const h = (await listWebhooks(c.db)).find((x) => x.id === id);
				if (h) await setWebhookActive(c.db, id, !h.active);
				return ok(await settingsPage(c), h?.active ? "Paused" : "Resumed");
			}
			if (verb === "delete") {
				await deleteWebhook(c.db, id);
				return ok(await settingsPage(c), "Webhook deleted");
			}
			return null;
		}
		case "import": {
			const r = await importMembersCsv(c.db, typeof v.csv === "string" ? v.csv : "", { paidPlan: str(v.plan) || undefined, paidDays: Number(v.days) || 0, source: str(v.source) || undefined, dryRun: bool(v.dry), now: c.now });
			const summary = bool(v.dry)
				? `Dry run: ${n(r.rows)} rows, ${n(r.errors.length)} problems. Recognised columns: ${r.columns.join(", ") || "none"}.`
				: `${n(r.created)} created, ${n(r.existing)} already members, ${n(r.granted)} given time, ${n(r.profiles)} profiles filled, ${n(r.errors.length)} problems.`;
			const blocks: Block[] = [banner(summary, undefined, r.errors.length ? "alert" : "default")];
			if (r.errors.length) blocks.push(code(r.errors.slice(0, 50).map((e) => `row ${e.row}: ${e.error}`).join("\n")));
			if (r.toLink.length && !bool(v.dry)) {
				const billing = billingOf(c);
				if (billing) {
					let linked = 0;
					for (const l of r.toLink) if ((await billing.linkCustomer(l.memberId, l.customerId)).ok) linked++;
					blocks.push(context(`Linked ${n(linked)} of ${n(r.toLink.length)} Stripe customers and pulled in their subscriptions.`));
				} else blocks.push(context(`${n(r.toLink.length)} rows have a Stripe customer id. Connect Stripe and import again to link them.`));
			}
			return importPage(c, blocks);
		}
		case "bulk": {
			const emails = str(v.emails).split(/[\s,;]+/).filter(Boolean);
			const count = await bulkGrant(c.db, { emails, plan: str(v.plan) || undefined, days: Number(v.days) || 0, reason: str(v.reason) || "Given by staff", batchKey: `${c.now}`, now: c.now });
			return ok(await importPage(c), `Gave time to ${n(count)} of ${n(emails.length)}`);
		}
		case "export": {
			const csv = await exportMembersCsv(c.db, { paidOnly: verb === "paid" });
			return importPage(c, [{ type: "accordion", label: `CSV export (${n(csv.split("\n").length - 1)} members; copy it)`, default_open: true, blocks: [code(csv)] }]);
		}
		case "note": {
			if (verb === "add") await addNote(c.db, id, str(v.body), c.actor, c.now);
			if (verb === "delete") await deleteNote(c.db, typeof i.value === "string" ? i.value : "");
			return ok(await memberPage(id), verb === "add" ? "Note added" : "Note deleted");
		}
		case "member": {
			if (verb !== "link") return null;
			const billing = billingOf(c);
			if (!billing) return fail(await memberPage(id), "Stripe isn't connected.");
			const r = await billing.linkCustomer(id, str(v.customer));
			return r.ok ? ok(await memberPage(id), `Linked; ${r.subscriptions} subscription(s) synced`) : fail(await memberPage(id), r.error);
		}
	}
	return null;
}

export const MORE_PAGES: Record<string, (c: Ctx) => Promise<AdminResponse>> = {
	"/access": (c) => accessPage(c),
	"/teams": (c) => teamsPage(c),
	"/gifts": (c) => giftsPage(c),
	"/downloads": (c) => downloadsPage(c),
	"/settings": (c) => settingsPage(c),
	"/import": (c) => importPage(c),
};
