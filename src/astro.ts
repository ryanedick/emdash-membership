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
	};
	/** Extra options for `createMemberships` (link TTL, session length, rate limits…). */
	options?: Omit<MembershipsConfig, "db" | "sender">;
}

export interface BillingRoutesConfig<OfferKey extends string = string> {
	/** E.g. `() => createBilling({ … })`. */
	billing: Lazy<Billing>;
	/** Offers a member may buy right now. Default: every offer is allowed. */
	purchasable?: (member: Member) => readonly OfferKey[] | Promise<readonly OfferKey[]>;
	/** False turns the routes off (503 / redirect), e.g. while Stripe keys aren't set. Default true. */
	enabled?: Lazy<boolean>;
}

type Ctx = Pick<APIContext, "request" | "url" | "cookies" | "locals" | "redirect">;

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
		...config.paths,
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

	/** Stripe routes: webhook, checkout and Customer Portal. */
	function billingRoutes<OfferKey extends string>(b: BillingRoutesConfig<OfferKey>) {
		const enabled = () => (b.enabled === undefined ? true : resolve(b.enabled));
		const billing = () => resolve(b.billing);

		/** POST. Point the Stripe webhook endpoint here (see `BILLING_WEBHOOK_EVENTS`). */
		const webhookRoute: APIRoute = async ({ request }: Ctx) => {
			if (!enabled()) return new Response("billing not configured", { status: 503 });
			// Raw body: parsing JSON first would break signature verification.
			const raw = await request.text();
			const { status, body } = await billing().handleWebhook(raw, request.headers.get("stripe-signature"));
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
			if (!enabled()) return unavailable();
			if (b.purchasable && !(await b.purchasable(member)).includes(offer)) return unavailable();

			let result: Awaited<ReturnType<Billing["startCheckout"]>>;
			try {
				result = await billing().startCheckout({
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
			if (!enabled()) return ctx.redirect(paths.account, 303);
			const portal = await billing().portalUrl(member, new URL(paths.account, ctx.url).toString());
			return ctx.redirect(portal ?? paths.account, 303);
		};

		return { webhookRoute, checkoutRoute, portalRoute };
	}

	return {
		/** A `Memberships` instance for anything the routes don't cover. */
		memberships: () => memberships(),
		middleware,
		loginRoute,
		verifyRoute,
		logoutRoute,
		peekLoginLink,
		billingRoutes,
		setSessionCookie,
		clearSessionCookie,
		cookieName,
	};
}

export type MembershipsAstro = ReturnType<typeof membershipsAstro>;
