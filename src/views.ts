/**
 * View models for the bundled components (and your own pages): everything a
 * pricing table or an account page needs, gathered in one call.
 */
import type { Db } from "./db.ts";
import { type DownloadAccess, downloadsFor } from "./downloads.ts";
import { type Gift, listGifts } from "./gifts.ts";
import type { Member } from "./memberships.ts";
import { cachedAccess, listPlans, listPrices, type MembershipPlan, type PlanPrice } from "./plans.ts";
import { getProfile, listProfileFields, type Profile, type ProfileField } from "./profile.ts";
import { type CancelFlow, getCancelFlow } from "./retention.ts";
import type { Billing, BillingSummary } from "./stripe.ts";
import { listSeats, listTeams, type Team, type TeamSeat } from "./teams.ts";

export interface PricingPrice extends PlanPrice {
	/** e.g. "$9 / month", "$90 / year", "$1 once" */
	label: string;
	/** For capped offers: places left (null = no cap), and whether it can be bought now */
	remaining: number | null;
	available: boolean;
	/** Monthly-equivalent for annual prices, e.g. "$7.50 / month" */
	perMonthLabel: string | null;
}

export interface PricingPlan extends MembershipPlan {
	prices: PricingPrice[];
	/** True when the viewer holds this plan */
	current: boolean;
}

export function formatMoney(minor: number, currency: string): string {
	try {
		const whole = minor % 100 === 0;
		return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : 2 }).format(minor / 100);
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
}

export function priceLabel(p: PlanPrice): string {
	const amount = formatMoney(p.amount, p.currency);
	if (p.kind === "one_time") return p.giftDays ? `${amount} for ${p.giftDays} days` : `${amount} once`;
	const unit = p.intervalCount > 1 ? `${p.intervalCount} ${p.interval}s` : p.interval;
	return `${amount}${p.perSeat ? " per seat" : ""} / ${unit}`;
}

/**
 * Visible plans with their active, purchasable prices, cheapest first.
 * Gift and per-seat prices are included (marked) so pages can show them separately.
 */
export async function pricingTable(db: Db, opts: { member?: Pick<Member, "id"> | null; billing?: Billing | null } = {}): Promise<PricingPlan[]> {
	const [plans, prices, access] = await Promise.all([listPlans(db), listPrices(db, { activeOnly: true }), opts.member ? cachedAccess(db, opts.member.id) : null]);
	const out: PricingPlan[] = [];
	for (const plan of plans.filter((p) => p.visible)) {
		const own = prices.filter((p) => p.planId === plan.id);
		const priced: PricingPrice[] = [];
		for (const p of own) {
			const avail = opts.billing ? await opts.billing.offerAvailability(p.lookupKey) : { available: true, remaining: null };
			priced.push({
				...p,
				label: priceLabel(p),
				remaining: avail.remaining,
				available: avail.available,
				perMonthLabel: p.kind === "recurring" && p.interval === "year" ? `${formatMoney(Math.round(p.amount / (12 * p.intervalCount)), p.currency)} / month` : null,
			});
		}
		priced.sort((a, b) => a.amount - b.amount);
		if (!plan.paid || priced.length) out.push({ ...plan, prices: priced, current: plan.paid ? !!access?.plans.includes(plan.id) : !access?.paid });
	}
	return out;
}

export interface AccountView {
	member: Member;
	plans: string[];
	entitlements: string[];
	billing: BillingSummary | null;
	/** Recurring prices the member could switch to */
	switchOptions: PricingPrice[];
	profileFields: ProfileField[];
	profile: Profile;
	teams: (Team & { admin: boolean; /** Seat list, for team admins only */ roster: TeamSeat[] | null })[];
	giftsBought: Gift[];
	downloads: DownloadAccess[];
	cancelFlow: CancelFlow;
}

/** Everything an account page shows, in one call. */
export async function accountView(db: Db, member: Member, opts: { billing?: Billing | null } = {}): Promise<AccountView> {
	const [access, summary, fields, profile, teams, gifts, downloads, flow, table] = await Promise.all([
		cachedAccess(db, member.id),
		opts.billing ? opts.billing.summary(member.id) : null,
		listProfileFields(db),
		getProfile(db, member.id),
		listTeams(db, { memberId: member.id }),
		listGifts(db, { buyerMemberId: member.id }),
		downloadsFor(db, member),
		getCancelFlow(db),
		pricingTable(db, { member, billing: opts.billing ?? null }),
	]);
	const current = summary?.subscription?.lookupKey ?? null;
	const switchOptions = table.flatMap((p) => p.prices).filter((p) => p.kind === "recurring" && !p.perSeat && p.lookupKey !== current && p.available);
	const teamViews = [];
	for (const t of teams) {
		const seats = await listSeats(db, t.id);
		const admin = seats.some((s) => s.memberId === member.id && s.role === "admin");
		teamViews.push({ ...t, admin, roster: admin ? seats : null });
	}
	return {
		member,
		plans: access.plans,
		entitlements: access.entitlements,
		billing: summary,
		switchOptions,
		profileFields: fields,
		profile,
		teams: teamViews,
		giftsBought: gifts.filter((g) => g.status !== "pending"),
		downloads,
		cancelFlow: flow,
	};
}
