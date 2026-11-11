/**
 * Members admin, rendered as EmDash Block Kit. Every page and button routes
 * through `handleAdmin`. Action ids are `area:verb[:id]`.
 *
 * Pages that change Stripe (plans, prices, coupons, a member's subscription)
 * need a Stripe client; without one they render read-only with a notice.
 */
import { deleteMember, getMemberDetail, listMembers, memberStats, signOutEverywhere } from "../admin.ts";
import {
	archivePrice,
	createCoupon,
	createPrice,
	deactivateCoupon,
	importStripePrices,
	listCoupons,
	refreshCoupons,
	syncPlanProduct,
	updatePriceSettings,
} from "../catalog.ts";
import type { Db } from "../db.ts";
import { grantProTime, revokeGrant } from "../grants.ts";
import { listEarlyMembers } from "../launch.ts";
import {
	DEFAULT_TEMPLATES,
	EMAIL_KIND_LABELS,
	EMAIL_KINDS,
	type EmailKind,
	getLifecycleSettings,
	listOutbox,
	PLACEHOLDERS,
	renderEmail,
	saveLifecycleSettings,
	settingsProblems,
} from "../lifecycle.ts";
import { archivePlan, cachedAccess, getPlan, listPlans, listPrices, savePlan } from "../plans.ts";
import { conversionReport, revenueReport } from "../revenue.ts";
import type { PluginOptions } from "./options.ts";

import {
	type AdminDeps,
	type AdminResponse,
	type Block,
	type Ctx,
	type Interaction,
	PAGE,
	actions,
	banner,
	billingOf,
	bool,
	button,
	context,
	divider,
	form,
	header,
	iso,
	list,
	money,
	n,
	nav,
	num,
	pctText,
	priceLabel,
	pro,
	select,
	str,
	stripeNotice,
	text,
	toggle,
	when,
} from "./blocks.ts";
import { MORE_PAGES, memberExtras, moreActions } from "./admin-more.ts";
import { audit } from "../events.ts";

export type { AdminDeps, AdminResponse } from "./blocks.ts";

// ─────────────────────────────── overview ───────────────────────────────

async function overviewPage(c: Ctx): Promise<AdminResponse> {
	const [s, rev] = await Promise.all([memberStats(c.db, { ...pro(c.options), planValues: c.options.planValues, now: c.now }), revenueReport(c.db, { now: c.now })]);
	const hasTerms = rev.payingSubscriptions > 0 || rev.mrr > 0;
	const mrrStat = hasTerms
		? { label: "MRR", value: money(rev.mrr, rev.currency), description: `${money(rev.window.net, rev.currency)} net in 30 days` }
		: s.mrr !== null
			? { label: "MRR (list price)", value: money(s.mrr, c.options.currency), description: "Estimate until subscriptions sync" }
			: { label: "Signed in (30 days)", value: n(s.active30d) };
	return {
		blocks: [
			header("Members"),
			{
				type: "stats",
				items: [
					{ label: "Members", value: n(s.total), description: `${n(s.new30d)} new in 30 days` },
					{ label: "On a paid plan", value: n(s.pro), description: `${n(s.free)} on Free` },
					{ label: "Paying subscriptions", value: n(s.subscriptions), description: s.canceling ? `${n(s.canceling)} canceling` : "None canceling" },
					mrrStat,
				],
			},
			{ type: "chart", config: { chart_type: "timeseries", style: "bar", series: [{ name: "New members", data: s.growth }], height: 200 } },
			...(s.pastDue ? [banner(`${n(s.pastDue)} subscription${s.pastDue === 1 ? "" : "s"} past due`, "Stripe is retrying the payment. They keep access until Stripe gives up.", "alert")] : []),
			{
				type: "fields",
				fields: [
					{ label: "Early members", value: n(s.earlyMembers) },
					{ label: "Paid through comp time only", value: n(s.compOnly) },
					{ label: "Signed in (30 days)", value: n(s.active30d) },
					...Object.entries(s.byLookupKey).map(([k, v]) => ({ label: `Subscriptions: ${k || "unknown price"}`, value: n(v) })),
				],
			},
			actions(nav("All members", "/members", "primary"), nav("Revenue", "/revenue"), nav("Plans & prices", "/plans"), nav("Early members", "/early")),
		],
	};
}

async function widget(c: Ctx): Promise<AdminResponse> {
	const [s, rev] = await Promise.all([memberStats(c.db, { ...pro(c.options), planValues: c.options.planValues, now: c.now }), revenueReport(c.db, { now: c.now })]);
	const mrr = rev.mrr > 0 ? money(rev.mrr, rev.currency) : s.mrr !== null ? money(s.mrr, c.options.currency) : null;
	return {
		blocks: [
			{
				type: "stats",
				items: [{ label: "Members", value: n(s.total) }, { label: "Paid", value: n(s.pro) }, mrr ? { label: "MRR", value: mrr } : { label: "New (30d)", value: n(s.new30d) }],
			},
			actions(nav("Open members", "/", "primary")),
		],
	};
}

// ─────────────────────────────── members ───────────────────────────────

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

async function planOptions(c: Ctx, opts: { paidOnly?: boolean } = {}) {
	return (await listPlans(c.db)).filter((p) => !opts.paidOnly || p.paid).map((p) => ({ label: p.name, value: p.id }));
}

function grantForm(action_id: string, withEmail: boolean, plans: { label: string; value: string }[]): Block {
	return form(
		"grant",
		[
			...(withEmail ? [text("email", "Email")] : []),
			...(plans.length > 1 ? [select("plan", "Plan", plans, plans[0]?.value)] : []),
			num("days", "Days", 30, 1, 3650),
			text("reason", "Reason (shown in the member's history)", "", { placeholder: "Giveaway, support credit…" }),
		],
		"Give free time",
		action_id,
	);
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
					select("plan", "Plan", [{ label: "Any", value: "" }, { label: "Paid", value: "pro" }, { label: "Free", value: "free" }], plan ?? ""),
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
					plan: m.plan === "pro" ? "paid" : "free",
					billing: [m.subscriptionStatus ? `subscription ${m.subscriptionStatus}` : "", m.earlyMember ? "early member" : ""].filter(Boolean).join(" · "),
					joined: iso(m.createdAt),
					seen: iso(m.lastLoginAt),
					open: button("Open", "member:open", { value: m.id }),
				})),
				...(offset + PAGE < total ? { next_cursor: JSON.stringify({ ...f, offset: offset + PAGE }) } : {}),
			},
			header("Give someone free time on a plan"),
			context("Works for any email address. If they've never signed in, a Free member is created and upgraded; the plan applies as soon as they sign in."),
			grantForm("member:grant-email", true, await planOptions(c, { paidOnly: true })),
		],
	};
}

async function memberPage(c: Ctx, id: string): Promise<AdminResponse> {
	const d = await getMemberDetail(c.db, id, c.now);
	if (!d) return { ...(await membersPage(c)), toast: { type: "error", message: "Member not found" } };
	const m = d.member;
	const [access, plans, prices, emails] = await Promise.all([
		cachedAccess(c.db, m.id),
		listPlans(c.db, { includeArchived: true }),
		listPrices(c.db, { activeOnly: true }),
		listOutbox(c.db, { memberId: m.id, limit: 10 }),
	]);
	const planName = (pid: string | null) => plans.find((p) => p.id === pid)?.name ?? pid ?? "—";
	const stripeBase = (c.options.stripeDashboardUrl ?? "https://dashboard.stripe.com").replace(/\/$/, "");
	const live = d.subscriptions.find((s) => (c.options.proStatuses ?? ["active", "trialing", "past_due"]).includes(s.status));
	const recurring = prices.filter((p) => p.kind === "recurring");
	const why = [
		live && "a subscription",
		d.earlyAccessAt && !d.earlyAccessRevokedAt && (!d.graceEndsAt || d.graceEndsAt > c.now) && "early access",
		d.grants.some((g) => !g.revokedAt && g.endsAt > c.now) && "comp time",
	].filter(Boolean);
	const paidPlans = await planOptions(c, { paidOnly: true });
	return {
		blocks: [
			header(m.email),
			...(d.riskFlag ? [banner("Payment risk flagged by Stripe", `${d.riskFlag}. Check the customer in Stripe before giving them anything.`, "error")] : []),
			{
				type: "fields",
				fields: [
					{ label: "Plans", value: access.plans.length ? `${access.plans.map(planName).join(", ")}${why.length ? ` (from ${why.join(", ")})` : ""}` : "Free" },
					{ label: "Entitlements", value: access.entitlements.join(", ") || "—" },
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
						rows: d.subscriptions.map((s) => ({ status: s.status, price: s.lookupKey ?? "", renews: when(s.currentPeriodEnd), cancel: s.cancelAtPeriodEnd ? "Cancels at period end" : "" })),
					}
				: context("No subscriptions."),
			...(live && c.stripe
				? [
						...(recurring.length > 1
							? [
									form(
										"change",
										[
											select("price", "Move to", recurring.filter((p) => p.lookupKey !== live.lookupKey).map((p) => ({ label: `${planName(p.planId)}: ${priceLabel(p)}`, value: p.lookupKey }))),
											toggle("prorate", "Prorate (charge or credit the difference now)", true),
										],
										"Change plan",
										`sub:change:${m.id}`,
									),
								]
							: []),
						actions(
							live.cancelAtPeriodEnd
								? button("Resume subscription", `sub:resume:${m.id}`, { style: "primary" })
								: button("Cancel at period end", `sub:cancel:${m.id}`, { confirm: { title: "Cancel at the end of the period?", text: "They keep access until it ends, and get the cancellation email.", confirm: "Cancel at period end" } }),
							button("Cancel now", `sub:cancel-now:${m.id}`, { style: "danger", confirm: { title: "Cancel immediately?", text: "Access ends now. Refunds are made in Stripe.", confirm: "Cancel now" } }),
						),
					]
				: live
					? [context("Connect Stripe to change or cancel this subscription here.")]
					: []),
			header("Comp time"),
			d.grants.length
				? {
						type: "table",
						columns: [
							{ key: "plan", label: "Plan" },
							{ key: "reason", label: "Reason" },
							{ key: "period", label: "Period" },
							{ key: "state", label: "State", format: "badge" },
							{ key: "revoke", label: "", format: "element" },
						],
						rows: d.grants.map((g) => {
							const state = g.revokedAt ? "revoked" : g.endsAt <= c.now ? "ended" : g.startsAt > c.now ? "queued" : "active";
							return {
								plan: planName(g.planId ?? "pro"),
								reason: g.reason ?? g.key,
								period: `${when(g.startsAt)} → ${when(g.endsAt)}`,
								state,
								revoke:
									state === "active" || state === "queued"
										? button("Revoke", `grant:revoke:${m.id}`, { value: g.key, confirm: { title: "Revoke this time?", text: "It ends now. Stacked grants after it keep their dates.", confirm: "Revoke" } })
										: "",
							};
						}),
					}
				: context("No comp time."),
			grantForm(`member:grant:${m.id}`, false, paidPlans),
			...(emails.length
				? [
						header("Emails"),
						{
							type: "table",
							columns: [
								{ key: "kind", label: "Email" },
								{ key: "state", label: "State", format: "badge" },
								{ key: "at", label: "When", format: "relative_time" },
							],
							rows: emails.map((e) => ({ kind: EMAIL_KIND_LABELS[e.kind] ?? e.kind, state: e.sentAt ? (e.lastError === "skipped" ? "skipped" : "sent") : e.attempts ? "retrying" : "queued", at: iso(e.sentAt ?? e.sendAfter) })),
						},
					]
				: []),
			...(await memberExtras(c, m.id)),
			divider,
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

// ─────────────────────────────── plans ───────────────────────────────

async function plansPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const [plans, prices] = await Promise.all([listPlans(c.db, { includeArchived: true }), listPrices(c.db)]);
	const holders = await c.db.prepare(`SELECT plans FROM mbr_member_access WHERE plans <> '[]'`).all<{ plans: string }>();
	const count = (id: string) => holders.results.filter((r) => r.plans.includes(`"${id}"`)).length;
	return {
		blocks: [
			header("Plans & prices"),
			context("A plan grants entitlements (what your pages check, e.g. `archive`). Members get a plan by subscribing to one of its prices, buying a one-time price, or being given time. Everyone gets the Free plan's entitlements."),
			...stripeNotice(c),
			...extra,
			{
				type: "table",
				columns: [
					{ key: "name", label: "Plan" },
					{ key: "entitlements", label: "Entitlements" },
					{ key: "prices", label: "Prices" },
					{ key: "members", label: "Members" },
					{ key: "state", label: "", format: "badge" },
					{ key: "open", label: "", format: "element" },
				],
				rows: plans.map((p) => ({
					name: `${p.name} (${p.id})`,
					entitlements: p.entitlements.join(", ") || "—",
					prices: p.paid ? prices.filter((x) => x.planId === p.id && x.active).map(priceLabel).join(", ") || "none" : "free",
					members: p.paid ? n(count(p.id)) : "everyone",
					state: p.archivedAt ? "archived" : p.visible ? "" : "hidden",
					open: button("Open", "plan:open", { value: p.id }),
				})),
			},
			header("New plan"),
			form(
				"new-plan",
				[
					text("id", "ID (lowercase, can't change later)", "", { placeholder: "team" }),
					text("name", "Name", "", { placeholder: "Team" }),
					text("description", "Description (shown at checkout)"),
					text("entitlements", "Entitlements (comma-separated)", "", { placeholder: "pro, archive, seats" }),
				],
				"Create plan",
				"plan:create",
			),
			...(c.stripe
				? [
						header("Import from Stripe"),
						context("Adds active Stripe prices that have a lookup key and aren't listed yet. A price joins the plan named in its product's `plan_id` metadata, otherwise Pro."),
						actions(button("Import prices", "plan:import")),
					]
				: []),
		],
	};
}

async function planPage(c: Ctx, id: string): Promise<AdminResponse> {
	const plan = await getPlan(c.db, id);
	if (!plan) return { ...(await plansPage(c)), toast: { type: "error", message: "Plan not found" } };
	const prices = await listPrices(c.db, { planId: id });
	return {
		blocks: [
			header(`${plan.name} (${plan.id})`),
			...stripeNotice(c),
			...(plan.archivedAt ? [banner("Archived", "Not sold any more. Members who hold it keep it.", "alert")] : []),
			form(
				"plan",
				[
					text("name", "Name", plan.name),
					text("description", "Description", plan.description),
					text("entitlements", "Entitlements (comma-separated)", plan.entitlements.join(", ")),
					num("sort", "Sort order", plan.sortOrder, 0, 10000),
					toggle("visible", "Show on pricing tables", plan.visible),
				],
				"Save plan",
				`plan:save:${plan.id}`,
			),
			...(plan.paid
				? [
						header("Prices"),
						prices.length
							? {
									type: "table",
									columns: [
										{ key: "key", label: "Lookup key" },
										{ key: "price", label: "Price" },
										{ key: "extras", label: "" },
										{ key: "state", label: "State", format: "badge" },
										{ key: "archive", label: "", format: "element" },
									],
									rows: prices.map((p) => ({
										key: p.lookupKey,
										price: priceLabel(p),
										extras: [p.trialDays ? `${p.trialDays}-day trial` : "", p.grantsEarlyAccess ? "early access" : "", p.syncError ? `sync error: ${p.syncError}` : "", p.stripePriceId ? "" : "not in Stripe"]
											.filter(Boolean)
											.join(" · "),
										state: p.active ? "active" : "archived",
										archive:
											p.active && c.stripe
												? button("Archive", `price:archive:${plan.id}`, { value: p.lookupKey, confirm: { title: "Stop selling this price?", text: "Existing subscriptions on it continue.", confirm: "Archive" } })
												: "",
									})),
								}
							: context("No prices yet."),
						...(c.stripe
							? [
									header("Add or change a price"),
									context("Re-using a lookup key with new terms creates a new Stripe price that takes the key over; subscribers on the old one keep it. Same terms just update the trial or early-access settings."),
									form(
										"price",
										[
											text("lookup_key", "Lookup key", "", { placeholder: `${plan.id}_monthly` }),
											select("billing", "Billing", [
												{ label: "Monthly", value: "month" },
												{ label: "Yearly", value: "year" },
												{ label: "One-time", value: "one_time" },
											], "month"),
											text("amount", "Amount (e.g. 9 or 9.99)"),
											text("currency", "Currency", "usd"),
											num("trial_days", "Free trial days (subscriptions)", 0, 0, 365),
											toggle("early", "One-time price grants early access (early-member badge)", false),
										],
										"Save price",
										`price:create:${plan.id}`,
									),
								]
							: []),
					]
				: [context("The Free plan has no prices. Its entitlements apply to every member, signed in or about to be.")]),
			actions(
				...(plan.paid && c.stripe ? [button("Sync to Stripe", `plan:sync:${plan.id}`)] : []),
				...(plan.paid
					? [
							plan.archivedAt
								? button("Unarchive", `plan:unarchive:${plan.id}`)
								: button("Archive plan", `plan:archive:${plan.id}`, { style: "danger", confirm: { title: "Archive this plan?", text: "It can't be bought any more. Members who hold it keep it.", confirm: "Archive" } }),
						]
					: []),
				nav("All plans", "/plans"),
			),
		],
	};
}

// ─────────────────────────────── coupons ───────────────────────────────

async function couponsPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const coupons = await listCoupons(c.db);
	return {
		blocks: [
			header("Coupons"),
			context("Promotion codes customers type at Stripe Checkout. The code field appears at checkout while any code is active."),
			...stripeNotice(c),
			...extra,
			{
				type: "table",
				empty_text: "No coupons yet.",
				columns: [
					{ key: "code", label: "Code" },
					{ key: "discount", label: "Discount" },
					{ key: "limits", label: "Limits" },
					{ key: "used", label: "Redeemed" },
					{ key: "state", label: "State", format: "badge" },
					{ key: "off", label: "", format: "element" },
				],
				rows: coupons.map((cp) => ({
					code: cp.code,
					discount: `${cp.percentOff ? `${cp.percentOff}%` : money(cp.amountOff ?? 0, cp.currency ?? "usd")} off ${cp.duration === "repeating" ? `for ${cp.durationMonths} months` : cp.duration === "forever" ? "forever" : "once"}`,
					limits: [cp.maxRedemptions ? `max ${cp.maxRedemptions}` : "", cp.expiresAt ? `until ${when(cp.expiresAt)}` : "", cp.firstTimeOnly ? "first purchase only" : ""].filter(Boolean).join(" · ") || "—",
					used: n(cp.timesRedeemed),
					state: cp.active && (!cp.expiresAt || cp.expiresAt > c.now) ? "active" : "inactive",
					off: cp.active && c.stripe ? button("Deactivate", "coupon:off", { value: cp.id, confirm: { title: `Deactivate ${cp.code}?`, text: "It can't be redeemed any more. Discounts already applied continue.", confirm: "Deactivate" } }) : "",
				})),
			},
			...(c.stripe
				? [
						actions(button("Refresh redemption counts", "coupon:refresh")),
						header("New coupon"),
						form(
							"coupon",
							[
								text("code", "Code", "", { placeholder: "LAUNCH25" }),
								select("type", "Discount", [
									{ label: "Percent off", value: "percent" },
									{ label: "Amount off", value: "amount" },
								], "percent"),
								text("value", "Percent (e.g. 25) or amount (e.g. 5.00)"),
								text("currency", "Currency (amount off only)", "usd"),
								select("duration", "Applies", [
									{ label: "To the first payment", value: "once" },
									{ label: "For some months", value: "repeating" },
									{ label: "Forever", value: "forever" },
								], "once"),
								num("months", "Months (if for some months)", 3, 1, 36),
								num("max", "Max redemptions (0 = unlimited)", 0, 0, 1_000_000),
								text("expires", "Expires (YYYY-MM-DD, blank = never)"),
								toggle("first", "First purchase only", false),
							],
							"Create coupon",
							"coupon:create",
						),
					]
				: []),
		],
	};
}

// ─────────────────────────────── revenue ───────────────────────────────

async function revenuePage(c: Ctx): Promise<AdminResponse> {
	const [r, conv] = await Promise.all([revenueReport(c.db, { now: c.now }), conversionReport(c.db, { now: c.now })]);
	const m = (x: number) => money(x, r.currency);
	return {
		blocks: [
			header("Revenue"),
			context(`From Stripe amounts after recurring discounts, in ${r.currency.toUpperCase()}. Trials count once they convert; annual plans count 1/12 a month.`),
			{
				type: "stats",
				items: [
					{ label: "MRR", value: m(r.mrr), description: `${m(r.arr)} ARR` },
					{ label: "Paying subscriptions", value: n(r.payingSubscriptions), description: `${n(r.trialing)} trialing` },
					{ label: "Average per subscription", value: m(r.arpu) },
					{ label: "Net new MRR (30 days)", value: m(r.window.net), trend: r.window.net >= 0 ? "up" : "down" },
				],
			},
			{ type: "chart", config: { chart_type: "timeseries", style: "line", series: [{ name: "MRR", data: r.history.map(([t, v]) => [t, v / 100]) }], height: 220 } },
			header("Last 30 days"),
			{
				type: "fields",
				fields: [
					{ label: "New", value: m(r.window.new) },
					{ label: "Expansion", value: m(r.window.expansion) },
					{ label: "Reactivation", value: m(r.window.reactivation) },
					{ label: "Contraction", value: m(r.window.contraction) },
					{ label: "Churned", value: m(r.window.churn) },
					{ label: "Revenue churn", value: pctText(r.revenueChurnRate) },
					{ label: "Subscription churn", value: pctText(r.logoChurnRate) },
					{ label: "New members → paid", value: conv.joined ? `${n(conv.convertedToPaid)} of ${n(conv.joined)} (${pctText(conv.convertedToPaid / conv.joined)})` : "—" },
					{ label: "Trials converted", value: conv.trialsEnded ? `${n(conv.trialsConverted)} of ${n(conv.trialsEnded)}` : "—" },
				],
			},
			context("Figures start from when this version was installed; earlier history isn't in the movement log."),
		],
	};
}

// ─────────────────────────────── emails ───────────────────────────────

async function emailsPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const [s, outbox] = await Promise.all([getLifecycleSettings(c.db), listOutbox(c.db, { limit: 25 })]);
	const problems = settingsProblems(s);
	return {
		blocks: [
			header("Emails"),
			context("Sent automatically when billing changes. Stripe sends receipts and card-expiry notices itself (Dashboard → Settings → Customer emails)."),
			...(problems.length ? [banner("Emails are queued but not sent yet", problems.join(" "), "alert")] : []),
			...extra,
			form(
				"settings",
				[
					text("from_email", "From address", s.from?.email, { placeholder: "hello@example.com" }),
					text("from_name", "From name", s.from?.name),
					text("reply_to", "Reply-to", s.replyTo),
					text("site_name", "Site name", s.siteName),
					text("site_url", "Site URL", s.siteUrl, { placeholder: "https://example.com" }),
					text("account_path", "Account page path", s.accountPath),
					text("pricing_path", "Pricing page path", s.pricingPath),
					num("winback_days", "Win-back after (days, 0 = never)", s.winBackDays, 0, 365),
					text("winback_code", "Coupon code offered in the win-back (optional)", s.winBackCode),
					...EMAIL_KINDS.map((k) => toggle(`on_${k}`, EMAIL_KIND_LABELS[k], s.enabled[k])),
				],
				"Save settings",
				"email:settings",
			),
			header("Templates"),
			context(`Plain text; blank lines make paragraphs and links are clickable. Placeholders: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}. Clear both fields to go back to the default.`),
			...EMAIL_KINDS.map((k) => {
				const t = s.templates[k] ?? DEFAULT_TEMPLATES[k];
				return {
					type: "accordion",
					label: `${EMAIL_KIND_LABELS[k]}${s.templates[k] ? " (edited)" : ""}`,
					blocks: [
						form(`tpl-${k}`, [text("subject", "Subject", t.subject), text("body", "Body", t.body, { multiline: true })], "Save template", `email:template:${k}`),
						actions(...(c.transport ? [button("Send me a test", `email:test:${k}`)] : [])),
					],
				};
			}),
			header("Recent"),
			{
				type: "table",
				empty_text: "Nothing sent yet.",
				columns: [
					{ key: "kind", label: "Email" },
					{ key: "to", label: "To" },
					{ key: "state", label: "State", format: "badge" },
					{ key: "at", label: "When", format: "relative_time" },
					{ key: "error", label: "" },
				],
				rows: outbox.map((e) => ({
					kind: EMAIL_KIND_LABELS[e.kind] ?? e.kind,
					to: e.to,
					state: e.sentAt ? (e.lastError === "skipped" ? "skipped" : "sent") : e.attempts ? "retrying" : "queued",
					at: iso(e.sentAt ?? e.sendAfter),
					error: e.sentAt ? "" : (e.lastError ?? ""),
				})),
			},
		],
	};
}

// ─────────────────────────────── early members ───────────────────────────────

async function earlyPage(c: Ctx, extra: Block[] = []): Promise<AdminResponse> {
	const early = await listEarlyMembers(c.db, pro(c.options));
	const active = early.filter((e) => !e.refunded);
	return {
		blocks: [
			header("Early members"),
			context("Everyone who bought early access. The badge is permanent, even after a refund or a downgrade."),
			{
				type: "stats",
				items: [
					{ label: "Early members", value: n(active.length), description: `${n(early.length - active.length)} refunded` },
					{ label: "Now subscribed", value: n(active.filter((e) => e.subscribed).length) },
					{ label: "On a paid plan", value: n(active.filter((e) => e.plan === "pro").length) },
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
				rows: early.map((e) => ({
					email: e.email,
					since: iso(e.earlyMemberSince),
					plan: e.plan === "pro" ? "paid" : "free",
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

/** "9", "9.5", "9.99" → minor units; null when invalid. */
function toMinor(v: unknown): number | null {
	const s = str(v).replace(/[$,\s]/g, "");
	if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
	return Math.round(Number(s) * 100);
}

const PRICE_ERRORS: Record<string, string> = {
	unknown_plan: "Unknown plan.",
	free_plan: "The Free plan can't have prices.",
	invalid_lookup_key: "Lookup keys use letters, numbers, _ . and - (no spaces).",
	invalid_amount: "Enter an amount like 9 or 9.99.",
	invalid_currency: "Use a 3-letter currency code like usd.",
	invalid_interval: "Pick monthly or yearly.",
	lookup_key_taken: "That lookup key belongs to another plan.",
};
const COUPON_ERRORS: Record<string, string> = {
	invalid_code: "Codes are 3–40 letters, numbers, _ or -.",
	code_taken: "That code already exists.",
	invalid_discount: "Enter a percent (1–100), or an amount with a currency.",
	invalid_duration: "Repeating coupons need 1–36 months.",
};

// ─────────────────────────────── actions ───────────────────────────────

async function act(c: Ctx, i: Interaction): Promise<AdminResponse> {
	const [area, verb, ...rest] = (i.action_id ?? "").split(":");
	const id = rest.join(":") || (typeof i.value === "string" ? i.value : "");
	const v = i.values ?? {};
	const more = await moreActions(c, i, (memberId) => memberPage(c, memberId));
	if (more) return more;
	const ok = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "success", message } });
	const fail = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "error", message } });
	const proOpts = pro(c.options);
	const deps = c.stripe ? { db: c.db, stripe: c.stripe, now: c.now } : null;
	const needStripe = async (r: () => Promise<AdminResponse>) => fail(await r(), "Stripe isn't connected.");

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
		const early = await listEarlyMembers(c.db, proOpts);
		const csv = [
			"email,early_member_since,plan,subscribed,refunded",
			...early.map((e) => [e.email, iso(e.earlyMemberSince), e.plan, e.subscribed, e.refunded].map(csvCell).join(",")),
		].join("\n");
		return earlyPage(c, [{ type: "accordion", label: "CSV export (copy it)", default_open: true, blocks: [{ type: "code", code: csv, language: "bash" }] }]);
	}
	if (area === "grant" && verb === "revoke") {
		const key = typeof i.value === "string" ? i.value : "";
		const g = key ? await revokeGrant(c.db, key, { ...proOpts, now: c.now }) : null;
		return g ? ok(await memberPage(c, id), "Time revoked") : fail(await memberPage(c, id), "Grant not found");
	}
	if (area === "member") {
		switch (verb) {
			case "open":
				return memberPage(c, id);
			case "grant":
			case "grant-email": {
				const days = Number(v.days);
				let email = str(v.email);
				const back = () => (verb === "grant" ? memberPage(c, id) : membersPage(c));
				if (verb === "grant") {
					const d = await getMemberDetail(c.db, id, c.now);
					if (!d) return fail(await membersPage(c), "Member not found");
					email = d.member.email;
				}
				if (!Number.isFinite(days) || days <= 0) return fail(await back(), "Enter a number of days above zero.");
				const r = await grantProTime(c.db, {
					email,
					days,
					plan: str(v.plan) || undefined,
					key: `admin:${crypto.randomUUID()}`,
					reason: str(v.reason) || "Given by staff",
					...proOpts,
					now: c.now,
				});
				if (!r.ok) {
					return fail(await back(), r.reason === "invalid_email" ? "That email address isn't valid." : r.reason === "invalid_plan" ? "Pick a paid plan." : "Enter a number of days above zero.");
				}
				return ok(await memberPage(c, r.grant.memberId), `Gave ${days} day${days === 1 ? "" : "s"}, until ${when(r.grant.endsAt)}`);
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
					r.reason === "has_subscription" ? "Cancel their subscription first; the next webhook needs the member." : "Member not found",
				);
			}
		}
	}
	if (area === "sub") {
		const billing = billingOf(c);
		if (!billing) return needStripe(() => memberPage(c, id));
		const r =
			verb === "change"
				? await billing.changePlan(id, str(v.price), { prorate: v.prorate === undefined ? true : bool(v.prorate) })
				: verb === "cancel"
					? await billing.cancelSubscription(id, { atPeriodEnd: true })
					: verb === "cancel-now"
						? await billing.cancelSubscription(id, { atPeriodEnd: false })
						: await billing.resumeSubscription(id);
		const done = { change: "Plan changed", cancel: "Cancels at the end of the period", "cancel-now": "Subscription canceled", resume: "Subscription resumed" }[verb] ?? "Done";
		return r.ok ? ok(await memberPage(c, id), done) : fail(await memberPage(c, id), r.reason === "stripe_error" ? (r.error ?? "Stripe error") : r.reason.replace(/_/g, " "));
	}
	if (area === "plan") {
		switch (verb) {
			case "open":
				return planPage(c, id);
			case "create": {
				const r = await savePlan(c.db, { id: str(v.id), name: str(v.name), description: str(v.description), entitlements: list(v.entitlements) }, c.now);
				if (!r.ok) return fail(await plansPage(c), r.reason === "invalid_id" ? "IDs are lowercase letters, numbers, _ or -." : "Give the plan a name.");
				if (!r.created) return fail(await plansPage(c), "A plan with that ID already exists.");
				if (deps) await syncPlanProduct(deps, r.plan.id);
				return ok(await planPage(c, r.plan.id), "Plan created");
			}
			case "save": {
				const plan = await getPlan(c.db, id);
				if (!plan) return fail(await plansPage(c), "Plan not found");
				const r = await savePlan(
					c.db,
					{ id, name: str(v.name), description: str(v.description), entitlements: list(v.entitlements), sortOrder: Number(v.sort) || 0, visible: bool(v.visible) },
					c.now,
				);
				if (!r.ok) return fail(await planPage(c, id), "Give the plan a name.");
				const synced = deps && plan.paid ? await syncPlanProduct(deps, id) : null;
				return synced && !synced.ok ? fail(await planPage(c, id), `Saved, but Stripe: ${synced.error}`) : ok(await planPage(c, id), "Plan saved");
			}
			case "sync": {
				if (!deps) return needStripe(() => planPage(c, id));
				const r = await syncPlanProduct(deps, id);
				return r.ok ? ok(await planPage(c, id), "Synced to Stripe") : fail(await planPage(c, id), r.error);
			}
			case "archive":
			case "unarchive": {
				await archivePlan(c.db, id, verb === "archive", c.now);
				if (deps) await syncPlanProduct(deps, id);
				return ok(await planPage(c, id), verb === "archive" ? "Plan archived" : "Plan restored");
			}
			case "import": {
				if (!deps) return needStripe(() => plansPage(c));
				const r = await importStripePrices(deps);
				const msg = r.imported.length ? `Imported ${r.imported.map((x) => x.lookupKey).join(", ")}` : "Nothing new to import";
				return ok(await plansPage(c, r.skipped.length ? [context(`Skipped: ${r.skipped.map((s) => `${s.lookupKey ?? "(no key)"}: ${s.reason}`).join("; ")}`)] : []), msg);
			}
		}
	}
	if (area === "price") {
		if (!deps) return needStripe(() => planPage(c, id));
		if (verb === "archive") {
			const r = await archivePrice(deps, typeof i.value === "string" ? i.value : "");
			return r.ok ? ok(await planPage(c, id), "Price archived") : fail(await planPage(c, id), r.error);
		}
		if (verb === "create") {
			const amount = toMinor(v.amount);
			if (amount === null) return fail(await planPage(c, id), PRICE_ERRORS.invalid_amount);
			const billingKind = str(v.billing) || "month";
			const once = billingKind === "one_time";
			const lookupKey = str(v.lookup_key);
			const r = await createPrice(deps, {
				planId: id,
				lookupKey,
				kind: once ? "one_time" : "recurring",
				amount,
				currency: str(v.currency) || "usd",
				interval: once ? null : billingKind === "year" ? "year" : "month",
				trialDays: once ? 0 : Number(v.trial_days) || 0,
				grantsEarlyAccess: once && bool(v.early),
			});
			if (!r.ok) return fail(await planPage(c, id), r.reason === "stripe_error" ? `Stripe: ${"error" in r ? r.error : ""}` : (PRICE_ERRORS[r.reason] ?? r.reason));
			await updatePriceSettings(c.db, lookupKey, { trialDays: Number(v.trial_days) || 0, grantsEarlyAccess: once && bool(v.early) }, c.now);
			return ok(await planPage(c, id), `Saved ${lookupKey}: ${priceLabel(r.price)}`);
		}
	}
	if (area === "coupon") {
		if (!deps) return needStripe(() => couponsPage(c));
		if (verb === "off") {
			const r = await deactivateCoupon(deps, id);
			return r.ok ? ok(await couponsPage(c), "Coupon deactivated") : fail(await couponsPage(c), r.error);
		}
		if (verb === "refresh") return ok(await couponsPage(c), `Updated ${await refreshCoupons(deps)} coupons`);
		if (verb === "create") {
			const percent = str(v.type) !== "amount";
			const value = str(v.value);
			const expires = str(v.expires);
			const expiresAt = expires ? Date.parse(`${expires}T23:59:59Z`) : undefined;
			if (expires && !Number.isFinite(expiresAt)) return fail(await couponsPage(c), "Use YYYY-MM-DD for the expiry date.");
			const duration = (["once", "repeating", "forever"].includes(str(v.duration)) ? str(v.duration) : "once") as "once" | "repeating" | "forever";
			const r = await createCoupon(deps, {
				code: str(v.code),
				...(percent ? { percentOff: Number(value) } : { amountOff: toMinor(value) ?? -1, currency: str(v.currency) || "usd" }),
				duration,
				durationMonths: Number(v.months) || undefined,
				maxRedemptions: Number(v.max) || undefined,
				expiresAt,
				firstTimeOnly: bool(v.first),
			});
			if (!r.ok) return fail(await couponsPage(c), r.reason === "stripe_error" ? `Stripe: ${r.error ?? ""}` : (COUPON_ERRORS[r.reason] ?? r.reason));
			return ok(await couponsPage(c), `Created ${r.coupon.code}`);
		}
	}
	if (area === "email") {
		if (verb === "settings") {
			const fromEmail = str(v.from_email);
			const enabled = Object.fromEntries(EMAIL_KINDS.map((k) => [k, bool(v[`on_${k}`])])) as Record<EmailKind, boolean>;
			await saveLifecycleSettings(c.db, {
				from: fromEmail ? { email: fromEmail, ...(str(v.from_name) && { name: str(v.from_name) }) } : null,
				replyTo: str(v.reply_to) || null,
				siteName: str(v.site_name),
				siteUrl: str(v.site_url).replace(/\/$/, ""),
				accountPath: str(v.account_path) || "/account",
				pricingPath: str(v.pricing_path) || "/pricing",
				winBackDays: Math.max(0, Math.floor(Number(v.winback_days) || 0)),
				winBackCode: str(v.winback_code).toUpperCase() || null,
				enabled,
			});
			return ok(await emailsPage(c), "Settings saved");
		}
		const kind = id as EmailKind;
		if (!EMAIL_KINDS.includes(kind)) return fail(await emailsPage(c), "Unknown email");
		if (verb === "template") {
			const s = await getLifecycleSettings(c.db);
			const subject = str(v.subject);
			const body = typeof v.body === "string" ? v.body.trim() : "";
			const templates = { ...s.templates };
			if (!subject && !body) delete templates[kind];
			else templates[kind] = { subject: subject || DEFAULT_TEMPLATES[kind].subject, body: body || DEFAULT_TEMPLATES[kind].body };
			await saveLifecycleSettings(c.db, { templates });
			return ok(await emailsPage(c), subject || body ? "Template saved" : "Back to the default template");
		}
		if (verb === "test") {
			const s = await getLifecycleSettings(c.db);
			const problems = settingsProblems(s);
			if (problems.length || !c.transport) return fail(await emailsPage(c), problems.join(" ") || "No email transport is configured.");
			const to = s.replyTo || s.from!.email;
			const sample = renderEmail(kind, { planName: "Pro", date: c.now + 7 * 86_400_000, amount: 900, currency: "usd", nextAttempt: c.now + 3 * 86_400_000 }, s);
			try {
				await c.transport.send({ from: s.from!, to, subject: `[Test] ${sample.subject}`, text: sample.text, html: sample.html, category: "membership-test" });
			} catch (err) {
				return fail(await emailsPage(c), `Sending failed: ${(err as Error)?.message ?? err}`);
			}
			return ok(await emailsPage(c), `Test sent to ${to}`);
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
		case "/plans":
			return plansPage(c);
		case "/coupons":
			return couponsPage(c);
		case "/revenue":
			return revenuePage(c);
		case "/emails":
			return emailsPage(c);
		case "/early":
			return earlyPage(c);
		default:
			if (MORE_PAGES[path]) return MORE_PAGES[path](c);
			return overviewPage(c);
	}
}

export async function handleAdmin(db: Db, input: unknown, options: PluginOptions = {}, deps: AdminDeps | number = {}): Promise<AdminResponse> {
	const d: AdminDeps = typeof deps === "number" ? { now: deps } : deps;
	const i = (input ?? {}) as Interaction;
	const c: Ctx = { db, options, now: d.now ?? Date.now(), stripe: d.stripe ?? null, transport: d.transport ?? null, actor: d.actor ?? null };
	try {
		if (i.type === "page_load") return await renderPage(c, i.page ?? "/");
		if (i.type === "block_action" || i.type === "form_submit") {
			const r = await act(c, i);
			// Every successful staff action goes in the audit trail.
			if (r.toast?.type === "success") {
				const [area, , ...rest] = (i.action_id ?? "").split(":");
				const target = rest.join(":") || (typeof i.value === "string" ? i.value : "");
				const memberId = ["member", "sub", "grant", "note"].includes(area) && target.startsWith("mbr_") ? target : null;
				await audit(c.db, { actor: c.actor, action: i.action_id ?? "", memberId, detail: r.toast.message }, c.now).catch(() => {});
			}
			return r;
		}
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
