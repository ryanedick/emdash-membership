/**
 * Astro glue for EmDash sites: the session middleware and ready-made API
 * routes, so a site only writes its own pages.
 *
 * ```ts
 * // src/lib/members.ts
 * import { env } from "cloudflare:workers";
 * import { membershipsAstro } from "emdash-memberships/astro";
 * export const members = membershipsAstro({ db: () => env.DB, sender: () => mySender, dev: import.meta.env.DEV });
 *
 * // src/middleware.ts
 * export const onRequest = members.middleware;
 *
 * // src/pages/api/auth/login.ts
 * export const POST = members.loginRoute;
 * ```
 *
 * Only types are imported from Astro, so this module adds nothing to the bundle
 * beyond its own code. Stripe routes take a `Billing` from `emdash-memberships/stripe`.
 */
import type { APIContext, APIRoute, AstroCookies, MiddlewareHandler } from "astro";
import type { Db } from "./db.ts";
import type { LoginEmailSender } from "./email.ts";
import {
	createMemberships,
	type Member,
	type Memberships,
	type MembershipsConfig,
	safeNextPath,
} from "./memberships.ts";
import type { Billing } from "./stripe.ts";
import { getMembershipSecrets } from "./settings.ts";
import { type DownloadBucket, fetchDownload } from "./downloads.ts";
import { redeemGift } from "./gifts.ts";
import { needsOnboarding, saveProfile, listProfileFields } from "./profile.ts";
import { cancelStep } from "./retention.ts";
import { type AccessDecision, checkAccess, type ContentContext } from "./rules.ts";
import { autoJoinTeams, getTeam, inviteToTeam, isTeamAdmin, joinTeam, removeFromTeam, rotateTeamLink, setJoinDomain } from "./teams.ts";

type Lazy<T> = T | (() => T);
const resolve = <T>(v: Lazy<T>): T => (typeof v === "function" ? (v as () => T)() : v);

export interface MembershipsAstroConfig {
	/** The D1 binding, e.g. `() => env.DB`. A function, so it's read per request. */
	db: Lazy<Db>;
	/**
	 * Delivers sign-in links, e.g. `transportLoginSender({ transport: cloudflareEmailTransport(env.EMAIL), … })`.
	 * Use `devLinkSender()` locally.
	 */
	sender: Lazy<LoginEmailSender>;
	/**
	 * Development mode: the sign-in link is added to the "check your inbox"
	 * redirect as `?dev=<url>` so you can click it without email. Pass
	 * `import.meta.env.DEV`. Never true in production.
	 */
	dev?: boolean;
	/** Session cookie name. Default `mbr_session`. */
	cookieName?: string;
	/** Paths the middleware leaves alone. Default `["/_emdash"]` (EmDash admin has its own auth). */
	skipPaths?: string[];
	/** Visitor IP for rate limiting. Default: the `cf-connecting-ip` header. */
	clientIp?: (request: Request) => string | null;
	/**
	 * Bot check before a link is sent (e.g. Cloudflare Turnstile). Return false
	 * to reject. The form fields are passed so you can read the widget token.
	 */
	verifyHuman?: (form: FormData, ip: string | null) => boolean | Promise<boolean>;
	/** Page paths used by the built-in routes' redirects. */
	paths?: {
		/** Sign-in form. Default `/login` (errors come back as `?error=email|rate|send|verify|expired`). */
		login?: string;
		/** "Check your inbox" page. Default `/login/check`. */
		check?: string;
		/** Where members land after signing in, unless the link carried `next`. Default `/account`. */
		afterLogin?: string;
		/** Where members land after signing out. Default `/`. */
		afterLogout?: string;
		/** Pricing page, for checkout redirects. Default `/pricing`. */
		pricing?: string;
		/** Account page, the Customer Portal's return URL. Default `/account`. */
		account?: string;
		/** Page Stripe returns to after payment. Default `/billing/success`. */
		billingSuccess?: string;
		/** Onboarding page for required sign-up questions. Default `/account/profile`. */
		onboarding?: string;
		/** Cancel-flow page (shows reasons and offers). Default `/account/cancel`. */
		cancel?: string;
		/** Team page. Default `/account/team`. */
		team?: string;
	};
	/** After sign-in, send members who still owe required sign-up answers to `paths.onboarding`. Default false. */
	onboarding?: boolean;
	/** After sign-in, seat members on teams whose join domain matches their email. Default true. */
	autoJoinTeams?: boolean;
	/** Extra options for `createMemberships` (link TTL, session length, rate limits…). */
	options?: Omit<MembershipsConfig, "db" | "sender">;
}

export interface BillingRoutesConfig<OfferKey extends string = string> {
	/**
	 * E.g. `() => createBillingFromSettings({ db: env.DB })` (keys from the Members
	 * admin), or `() => createBilling({ … })`. May be async; null means billing
	 * isn't set up yet and the routes answer "unavailable".
	 */
	billing: Lazy<Billing | null | Promise<Billing | null>>;
	/** Offers a member may buy right now. Default: every offer is allowed. */
	purchasable?: (member: Member) => readonly OfferKey[] | Promise<readonly OfferKey[]>;
	/** False turns the routes off (503 / redirect), e.g. while Stripe keys aren't set. Default true. */
	enabled?: Lazy<boolean>;
}

type Ctx = Pick<APIContext, "request" | "url" | "cookies" | "locals" | "redirect">;

/**
 * A `verifyHuman` check using the Turnstile secret saved on Members →
 * Connections (or TURNSTILE_SECRET_KEY). Lets everyone through until a secret is set.
 *
 *   membershipsAstro({ verifyHuman: turnstileFromSettings(), … })
 */
export function turnstileFromSettings(opts: { fetch?: typeof fetch } = {}) {
	return async (form: FormData, ip: string | null): Promise<boolean> => {
		const { turnstileSecret } = await getMembershipSecrets();
		return turnstileVerifier(turnstileSecret ?? undefined, opts)(form, ip);
	};
}

/**
 * A `verifyHuman` check for Cloudflare Turnstile: put the widget in your
 * sign-in form, then `membershipsAstro({ verifyHuman: turnstileVerifier(() => env.TURNSTILE_SECRET_KEY), … })`.
 * With no secret set it lets everyone through (so local development works).
 */
export function turnstileVerifier(secret: Lazy<string | undefined>, opts: { fetch?: typeof fetch } = {}) {
	return async (form: FormData, ip: string | null): Promise<boolean> => {
		const key = resolve(secret);
		if (!key) return true;
		const token = String(form.get("cf-turnstile-response") ?? "");
		if (!token) return false;
		const body = new FormData();
		body.set("secret", key);
		body.set("response", token);
		if (ip) body.set("remoteip", ip);
		try {
			const res = await (opts.fetch ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
			return ((await res.json()) as { success?: boolean }).success === true;
		} catch {
			return false;
		}
	};
}

function localsOf(ctx: Pick<APIContext, "locals">): { member?: Member } {
	return ctx.locals as { member?: Member };
}

export function membershipsAstro(config: MembershipsAstroConfig) {
	const cookieName = config.cookieName ?? "mbr_session";
	const skip = config.skipPaths ?? ["/_emdash"];
	const ipOf = config.clientIp ?? ((r: Request) => r.headers.get("cf-connecting-ip"));
	const paths = {
		login: "/login",
		check: "/login/check",
		afterLogin: "/account",
		afterLogout: "/",
		pricing: "/pricing",
		account: "/account",
		billingSuccess: "/billing/success",
		onboarding: "/account/profile",
		cancel: "/account/cancel",
		team: "/account/team",
		...config.paths,
	};
	const db = () => resolve(config.db);
	const redirectBack = (ctx: Ctx, fallback: string, params: Record<string, string>, form?: FormData | null) => {
		const next = safeNextPath(String(form?.get("next") ?? "")) ?? fallback;
		return ctx.redirect(withParams(next, params), 303);
	};

	function memberships(sender?: LoginEmailSender): Memberships {
		return createMemberships({
			...config.options,
			db: resolve(config.db),
			sender: sender ?? resolve(config.sender),
		});
	}

	function setSessionCookie(cookies: AstroCookies, url: URL, token: string, expiresAt: number) {
		cookies.set(cookieName, token, {
			path: "/",
			httpOnly: true,
			secure: url.protocol === "https:",
			sameSite: "lax",
			expires: new Date(expiresAt),
		});
	}

	function clearSessionCookie(cookies: AstroCookies) {
		cookies.delete(cookieName, { path: "/" });
	}

	const withParams = (path: string, params: Record<string, string>) => {
		const q = new URLSearchParams(params);
		return q.size ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
	};

	/** Resolves the session cookie into `Astro.locals.member` and renews it when due. */
	const middleware: MiddlewareHandler = async (context, next) => {
		const token = context.cookies.get(cookieName)?.value;
		if (!token || skip.some((p) => context.url.pathname.startsWith(p))) return next();

		const session = await memberships().getSession(token);
		if (!session) {
			clearSessionCookie(context.cookies);
			return next();
		}
		if (session.renewed) setSessionCookie(context.cookies, context.url, token, session.expiresAt);
		localsOf(context).member = session.member;

		const response = await next();
		// A personalised page must never land in a shared cache.
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	};

	/** POST, form fields `email`, optional `next`. Emails a sign-in link. */
	const loginRoute: APIRoute = async ({ request, url, redirect }: Ctx) => {
		const form = await request.formData().catch(() => null);
		const email = String(form?.get("email") ?? "");
		const next = safeNextPath(String(form?.get("next") ?? "")) ?? "";
		const back = (params: Record<string, string>) =>
			redirect(withParams(paths.login, { ...params, ...(next && { next }) }), 303);

		// Honeypot field: bots fill every input. Pretend success without sending.
		if (String(form?.get("website") ?? "").trim()) return redirect(paths.check, 303);

		const ip = ipOf(request);
		if (config.verifyHuman && !(await config.verifyHuman(form ?? new FormData(), ip))) {
			return back({ error: "verify", email });
		}

		const sender = resolve(config.sender);
		let devUrl: string | undefined;
		const capture: LoginEmailSender = config.dev
			? {
					async send(e) {
						devUrl = e.url;
						await sender.send(e);
					},
				}
			: sender;

		const result = await memberships(capture).requestLoginLink({ email, origin: url.origin, next, ip });
		if (!result.ok) {
			const error = result.reason === "invalid_email" ? "email" : result.reason === "rate_limited" ? "rate" : "send";
			return back({ error, email });
		}
		return redirect(withParams(paths.check, config.dev && devUrl ? { dev: devUrl } : {}), 303);
	};

	/** POST, form field `token`. The verify page's button posts here. */
	const verifyRoute: APIRoute = async ({ request, url, cookies, redirect }: Ctx) => {
		const form = await request.formData().catch(() => null);
		const token = String(form?.get("token") ?? "");
		const result = await memberships().consumeLoginLink(token, { userAgent: request.headers.get("user-agent") });
		if (!result.ok) return redirect(withParams(paths.login, { error: "expired" }), 303);
		setSessionCookie(cookies, url, result.session.token, result.session.expiresAt);
		if (config.autoJoinTeams !== false) await autoJoinTeams(db(), result.member).catch((err) => console.error("[memberships] team auto-join failed", err));
		if (config.onboarding && (await needsOnboarding(db(), result.member.id))) {
			return redirect(withParams(paths.onboarding, result.next ? { next: result.next } : {}), 303);
		}
		return redirect(result.next ?? paths.afterLogin, 303);
	};

	/** POST. Ends the current session. */
	const logoutRoute: APIRoute = async ({ cookies, redirect }: Ctx) => {
		await memberships().revokeSession(cookies.get(cookieName)?.value);
		clearSessionCookie(cookies);
		return redirect(paths.afterLogout, 303);
	};

	/**
	 * For the verify page's frontmatter: checks the `?token=` link without using
	 * it up, and sets no-referrer / no-store headers. Returns the email or null.
	 */
	async function peekLoginLink(Astro: Pick<APIContext, "url"> & { response: { headers: Headers } }) {
		Astro.response.headers.set("Referrer-Policy", "no-referrer");
		Astro.response.headers.set("Cache-Control", "private, no-store");
		const token = Astro.url.searchParams.get("token") ?? "";
		const link = await memberships().peekLoginLink(token);
		return link ? { email: link.email, token } : null;
	}

	/**
	 * For page frontmatter: decides access to an entry under the admin's access
	 * rules. Pass what the page knows about the content.
	 *
	 *   const decision = await members.access(Astro, { collection: "tips", slug, fields: entry.data });
	 */
	async function access(ctx: Pick<APIContext, "locals">, content: ContentContext): Promise<AccessDecision> {
		return checkAccess(db(), localsOf(ctx).member, content);
	}

	const signedIn = (ctx: Ctx, back: string) => {
		const member = localsOf(ctx).member;
		return member ? { member, redirect: null } : { member: null, redirect: ctx.redirect(withParams(paths.login, { next: back }), 303) };
	};

	/** POST: profile answers (field keys as form names; repeat a name for multi-select). `next` to return somewhere. */
	const profileRoute: APIRoute = async (ctx: Ctx) => {
		const { member, redirect } = signedIn(ctx, paths.onboarding);
		if (!member) return redirect!;
		const form = await ctx.request.formData().catch(() => null);
		const fields = await listProfileFields(db());
		const input: Record<string, unknown> = {};
		for (const f of fields) {
			if (f.type === "multiselect") input[f.key] = form?.getAll(f.key).map(String) ?? [];
			else if (f.type === "checkbox") input[f.key] = form?.get(f.key) === "on" || form?.get(f.key) === "true";
			else if (form?.has(f.key)) input[f.key] = String(form.get(f.key));
		}
		const onboarding = form?.get("onboarding") === "1";
		const r = await saveProfile(db(), member.id, input, { requireAll: onboarding, signupOnly: onboarding });
		if (!r.ok) return ctx.redirect(withParams(onboarding ? paths.onboarding : paths.account, { error: "missing", fields: r.missing.join(",") }), 303);
		return redirectBack(ctx, onboarding ? paths.afterLogin : paths.account, { saved: "profile" }, form);
	};

	/** POST: form field `code`. Redeems a gift for the signed-in member. */
	const redeemGiftRoute: APIRoute = async (ctx: Ctx) => {
		const form = await ctx.request.formData().catch(() => null);
		const code = String(form?.get("code") ?? "").trim();
		const { member, redirect } = signedIn(ctx, `/gift/redeem?code=${encodeURIComponent(code)}`);
		if (!member) return redirect!;
		const r = await redeemGift(db(), code, member);
		return r.ok ? ctx.redirect(withParams(paths.account, { gift: "redeemed" }), 303) : redirectBack(ctx, "/gift/redeem", { error: r.reason, code }, form);
	};

	/** POST: form field `token` (the team's join link token). Seats the signed-in member. */
	const joinTeamRoute: APIRoute = async (ctx: Ctx) => {
		const form = await ctx.request.formData().catch(() => null);
		const token = String(form?.get("token") ?? "");
		const { member, redirect } = signedIn(ctx, `/team/join?token=${encodeURIComponent(token)}`);
		if (!member) return redirect!;
		const r = await joinTeam(db(), token, member);
		return r.ok ? ctx.redirect(withParams(paths.account, { team: "joined" }), 303) : ctx.redirect(withParams("/team/join", { token, error: r.reason }), 303);
	};

	/**
	 * POST: team admin actions. Fields: `team`, `action` = invite (`email`) |
	 * remove (`email`) | domain (`domain`, blank to clear) | rotate-link.
	 */
	const manageTeamRoute: APIRoute = async (ctx: Ctx) => {
		const form = await ctx.request.formData().catch(() => null);
		const teamId = String(form?.get("team") ?? "");
		const { member, redirect } = signedIn(ctx, paths.team);
		if (!member) return redirect!;
		if (!(await isTeamAdmin(db(), teamId, member.id))) return ctx.redirect(withParams(paths.team, { error: "not_admin" }), 303);
		const action = String(form?.get("action") ?? "");
		const email = String(form?.get("email") ?? "");
		let error: string | null = null;
		if (action === "invite") {
			const r = await inviteToTeam(db(), teamId, email);
			if (!r.ok) error = r.reason;
		} else if (action === "remove") {
			if (!(await removeFromTeam(db(), teamId, email))) error = "cant_remove";
		} else if (action === "domain") {
			if (!(await setJoinDomain(db(), teamId, String(form?.get("domain") ?? "") || null))) error = "invalid_domain";
		} else if (action === "rotate-link") await rotateTeamLink(db(), teamId);
		else error = "unknown_action";
		return ctx.redirect(withParams(paths.team, error ? { team: teamId, error } : { team: teamId, saved: action }), 303);
	};

	/**
	 * GET route for protected downloads, e.g. `src/pages/download/[id].ts`:
	 *   export const GET = members.downloadRoute({ bucket: () => env.MEDIA });
	 */
	function downloadRoute(opts: { bucket: Lazy<DownloadBucket>; param?: string }): APIRoute {
		return async (ctx) => {
			const id = String(ctx.params[opts.param ?? "id"] ?? "");
			const member = localsOf(ctx).member;
			if (!member) return ctx.redirect(withParams(paths.login, { next: ctx.url.pathname }), 303);
			const r = await fetchDownload(db(), resolve(opts.bucket), { id, member });
			if (!r.ok) {
				const status = r.reason === "not_found" || r.reason === "missing_file" ? 404 : 403;
				return new Response(r.reason === "limit" ? "Download limit reached" : r.reason === "entitlement" ? "Your plan doesn't include this download" : "Not found", { status });
			}
			return new Response(r.body, {
				headers: {
					"Content-Type": r.contentType,
					"Content-Disposition": `attachment; filename="${r.download.filename.replace(/"/g, "")}"`,
					"Cache-Control": "private, no-store",
					...(r.size ? { "Content-Length": String(r.size) } : {}),
				},
			});
		};
	}

	/** Stripe routes: webhook, checkout and Customer Portal. */
	function billingRoutes<OfferKey extends string>(b: BillingRoutesConfig<OfferKey>) {
		/** The billing instance, or null when it's switched off or not configured yet. */
		const load = async (): Promise<Billing | null> => {
			if (b.enabled !== undefined && !resolve(b.enabled)) return null;
			try {
				return (await resolve(b.billing)) ?? null;
			} catch (err) {
				console.error("[memberships] billing could not be created", err);
				return null;
			}
		};

		/** POST. Point the Stripe webhook endpoint here (see `BILLING_WEBHOOK_EVENTS`). */
		const webhookRoute: APIRoute = async ({ request }: Ctx) => {
			const billing = await load();
			if (!billing) return new Response("billing not configured", { status: 503 });
			// Raw body: parsing JSON first would break signature verification.
			const raw = await request.text();
			const { status, body } = await billing.handleWebhook(raw, request.headers.get("stripe-signature"));
			return new Response(body, { status });
		};

		/** POST, form field `offer`. Sends a signed-in member to Stripe Checkout. */
		const checkoutRoute: APIRoute = async (ctx: Ctx) => {
			const { request, url, redirect } = ctx;
			const form = await request.formData().catch(() => null);
			const offer = String(form?.get("offer") ?? "") as OfferKey;
			const member = localsOf(ctx).member;
			if (!member) return redirect(withParams(paths.login, { next: paths.pricing }), 303);

			const unavailable = () => redirect(withParams(paths.pricing, { checkout: "unavailable" }), 303);
			if (b.purchasable && !(await b.purchasable(member)).includes(offer)) return unavailable();
			const billing = await load();
			if (!billing) return unavailable();

			let result: Awaited<ReturnType<Billing["startCheckout"]>>;
			try {
				result = await billing.startCheckout({
					member,
					offer,
					successUrl: new URL(paths.billingSuccess, url).toString(),
					cancelUrl: new URL(withParams(paths.pricing, { checkout: "canceled" }), url).toString(),
				});
			} catch (err) {
				console.error("[memberships] checkout failed", err);
				return unavailable();
			}
			if (result.ok) return redirect(result.url, 303);
			if (result.reason === "already_pro" || result.reason === "already_subscribed") return redirect(paths.account, 303);
			console.error(`[memberships] checkout not started: ${result.reason}`);
			return unavailable();
		};

		/** POST. Opens the Stripe Customer Portal for the signed-in member. */
		const portalRoute: APIRoute = async (ctx: Ctx) => {
			const member = localsOf(ctx).member;
			if (!member) return ctx.redirect(withParams(paths.login, { next: paths.account }), 303);
			const billing = await load();
			if (!billing) return ctx.redirect(paths.account, 303);
			const portal = await billing.portalUrl(member, new URL(paths.account, ctx.url).toString());
			return ctx.redirect(portal ?? paths.account, 303);
		};

		const requireBilling = async (ctx: Ctx, back: string) => {
			const { member, redirect } = signedIn(ctx, back);
			if (!member) return { member: null, billing: null, response: redirect! };
			const billing = await load();
			if (!billing) return { member, billing: null, response: ctx.redirect(withParams(back, { error: "billing_unavailable" }), 303) };
			return { member, billing, response: null };
		};

		/** POST, form field `price` (a recurring price's lookup key). Moves the member's subscription. */
		const changePlanRoute: APIRoute = async (ctx: Ctx) => {
			const form = await ctx.request.formData().catch(() => null);
			const { member, billing: b2, response } = await requireBilling(ctx, paths.account);
			if (response) return response;
			const r = await b2!.changePlan(member!.id, String(form?.get("price") ?? ""));
			return ctx.redirect(withParams(paths.account, r.ok ? { saved: "plan" } : { error: r.reason }), 303);
		};

		/**
		 * POST, the cancel flow. Fields: `reason`, optional `comment`, and on the
		 * second step `decision` = accept | decline | keep. When the reason has a save
		 * offer, the first post redirects to `paths.cancel` with `offer=<reason>`.
		 */
		const cancelRoute: APIRoute = async (ctx: Ctx) => {
			const form = await ctx.request.formData().catch(() => null);
			const { member, billing: b2, response } = await requireBilling(ctx, paths.cancel);
			if (response) return response;
			const reason = String(form?.get("reason") ?? "");
			const comment = String(form?.get("comment") ?? "") || null;
			const decision = String(form?.get("decision") ?? "") as "accept" | "decline" | "keep" | "";
			const r = await cancelStep(db(), b2!, { memberId: member!.id, reason, comment, decision: decision || undefined });
			if (!r.ok) return ctx.redirect(withParams(paths.cancel, { error: r.reason }), 303);
			if (r.outcome === "offer") return ctx.redirect(withParams(paths.cancel, { offer: reason, ...(comment ? { comment } : {}) }), 303);
			return ctx.redirect(withParams(paths.account, { cancel: r.outcome }), 303);
		};

		/** POST. Undoes a cancellation scheduled for the period end, or ends a pause. */
		const resumeRoute: APIRoute = async (ctx: Ctx) => {
			const { member, billing: b2, response } = await requireBilling(ctx, paths.account);
			if (response) return response;
			const r = await b2!.resumeSubscription(member!.id);
			const r2 = r.ok ? r : await b2!.unpauseSubscription(member!.id);
			return ctx.redirect(withParams(paths.account, r2.ok ? { saved: "resumed" } : { error: r2.reason }), 303);
		};

		/** POST: `price` (a gift price), optional `recipient_email`, `recipient_name`, `message`, `deliver_on` (YYYY-MM-DD). */
		const giftCheckoutRoute: APIRoute = async (ctx: Ctx) => {
			const form = await ctx.request.formData().catch(() => null);
			const { member, billing: b2, response } = await requireBilling(ctx, "/gift");
			if (response) return response;
			const on = String(form?.get("deliver_on") ?? "");
			const deliverAt = on ? Date.parse(`${on}T09:00:00Z`) : null;
			const r = await b2!.startGiftCheckout({
				member: member!,
				lookupKey: String(form?.get("price") ?? ""),
				recipientEmail: String(form?.get("recipient_email") ?? "") || null,
				recipientName: String(form?.get("recipient_name") ?? "") || null,
				message: String(form?.get("message") ?? "") || null,
				deliverAt: Number.isFinite(deliverAt) ? deliverAt : null,
				successUrl: new URL(paths.billingSuccess, ctx.url).toString(),
				cancelUrl: new URL(withParams("/gift", { checkout: "canceled" }), ctx.url).toString(),
			});
			return r.ok ? ctx.redirect(r.url, 303) : ctx.redirect(withParams("/gift", { error: r.reason }), 303);
		};

		/** POST: `price` (a per-seat price), `seats`, `team_name`. */
		const teamCheckoutRoute: APIRoute = async (ctx: Ctx) => {
			const form = await ctx.request.formData().catch(() => null);
			const { member, billing: b2, response } = await requireBilling(ctx, paths.pricing);
			if (response) return response;
			const r = await b2!.startTeamCheckout({
				member: member!,
				lookupKey: String(form?.get("price") ?? ""),
				seats: Number(form?.get("seats") ?? 0),
				teamName: String(form?.get("team_name") ?? ""),
				successUrl: new URL(paths.billingSuccess, ctx.url).toString(),
				cancelUrl: new URL(withParams(paths.pricing, { checkout: "canceled" }), ctx.url).toString(),
			});
			return r.ok ? ctx.redirect(r.url, 303) : ctx.redirect(withParams(paths.pricing, { error: r.reason }), 303);
		};

		/** POST: `team`, `seats`. Team admins change the seat count (prorated). */
		const teamSeatsRoute: APIRoute = async (ctx: Ctx) => {
			const form = await ctx.request.formData().catch(() => null);
			const { member, billing: b2, response } = await requireBilling(ctx, paths.team);
			if (response) return response;
			const teamId = String(form?.get("team") ?? "");
			if (!(await isTeamAdmin(db(), teamId, member!.id)) || !(await getTeam(db(), { id: teamId }))) return ctx.redirect(withParams(paths.team, { error: "not_admin" }), 303);
			const r = await b2!.updateTeamSeats(teamId, Number(form?.get("seats") ?? 0));
			return ctx.redirect(withParams(paths.team, r.ok ? { team: teamId, saved: "seats" } : { team: teamId, error: r.error ?? r.reason }), 303);
		};

		return { load, webhookRoute, checkoutRoute, portalRoute, changePlanRoute, cancelRoute, resumeRoute, giftCheckoutRoute, teamCheckoutRoute, teamSeatsRoute };
	}

	return {
		/** A `Memberships` instance for anything the routes don't cover. */
		memberships: () => memberships(),
		middleware,
		loginRoute,
		verifyRoute,
		logoutRoute,
		peekLoginLink,
		access,
		profileRoute,
		redeemGiftRoute,
		joinTeamRoute,
		manageTeamRoute,
		downloadRoute,
		billingRoutes,
		setSessionCookie,
		clearSessionCookie,
		cookieName,
	};
}

export type MembershipsAstro = ReturnType<typeof membershipsAstro>;
