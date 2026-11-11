/**
 * An in-memory stand-in for the parts of the Stripe SDK this package calls.
 * Behaves like Stripe where it matters to us: lookup keys are unique among
 * prices and move with `transfer_lookup_key`, idempotency keys return the
 * first result, subscriptions carry items and discounts.
 */
import type Stripe from "stripe";

type Obj = Record<string, any>;

export class FakeStripe {
	static createSubtleCryptoProvider() {
		return {};
	}
	calls: { method: string; args: unknown[] }[] = [];
	products = new Map<string, Obj>();
	prices = new Map<string, Obj>();
	coupons = new Map<string, Obj>();
	promos = new Map<string, Obj>();
	subs = new Map<string, Obj>();
	customersMap = new Map<string, Obj>();
	sessions: Obj[] = [];
	private idem = new Map<string, unknown>();
	private seq = 0;
	/** Set to make the next call to a method fail */
	failNext: string | null = null;

	private id(prefix: string) {
		return `${prefix}_${++this.seq}`;
	}
	private call<T>(method: string, args: unknown[], opts: { idempotencyKey?: string } | undefined, fn: () => T): T {
		this.calls.push({ method, args });
		if (this.failNext === method) {
			this.failNext = null;
			throw new Error(`fake ${method} failure`);
		}
		if (opts?.idempotencyKey) {
			const k = `${method}:${opts.idempotencyKey}`;
			if (this.idem.has(k)) return this.idem.get(k) as T;
			const r = fn();
			this.idem.set(k, r);
			return r;
		}
		return fn();
	}

	get client(): Stripe {
		return this as unknown as Stripe;
	}

	readonly customers = {
		create: async (p: Obj, o?: Obj) =>
			this.call("customers.create", [p], o, () => {
				const c = { id: this.id("cus"), ...p };
				this.customersMap.set(c.id, c);
				return c;
			}),
	};

	readonly checkout = {
		sessions: {
			create: async (p: Obj) =>
				this.call("checkout.sessions.create", [p], undefined, () => {
					const s = { id: this.id("cs"), url: `https://checkout.test/${this.seq}`, ...p };
					this.sessions.push(s);
					return s;
				}),
		},
	};

	readonly billingPortal = {
		sessions: { create: async (p: Obj) => this.call("billingPortal.sessions.create", [p], undefined, () => ({ url: `https://portal.test/${p.customer}` })) },
	};

	readonly webhooks = {
		constructEventAsync: async (raw: string, sig: string) => {
			if (sig !== "valid") throw new Error("bad signature");
			return JSON.parse(raw);
		},
	};
}

/** The Stripe resource namespaces, attached so `stripe.products.create(...)` etc. work. */
export function fakeStripe(): FakeStripe & { client: Stripe } {
	const f = new FakeStripe();
	const self = f as any;
	const store = { products: f.products, prices: f.prices };
	self.products = Object.assign(store.products, {
		create: async (p: Obj, o?: Obj) =>
			self.call("products.create", [p], o, () => {
				const prod = { id: self.id("prod"), object: "product", active: true, ...p };
				store.products.set(prod.id, prod);
				return prod;
			}),
		update: async (id: string, p: Obj) =>
			self.call("products.update", [id, p], undefined, () => {
				const prod = store.products.get(id);
				if (!prod) throw new Error(`No such product: ${id}`);
				Object.assign(prod, p);
				return prod;
			}),
	});
	self.prices = Object.assign(store.prices, {
		create: async (p: Obj) =>
			self.call("prices.create", [p], undefined, () => {
				if (p.lookup_key) {
					for (const other of store.prices.values()) {
						if (other.lookup_key === p.lookup_key) {
							if (!p.transfer_lookup_key) throw new Error("lookup_key already in use");
							other.lookup_key = null;
						}
					}
				}
				const { transfer_lookup_key: _t, ...rest } = p;
				const price = {
					id: self.id("price"),
					object: "price",
					active: true,
					type: p.recurring ? "recurring" : "one_time",
					metadata: {},
					...rest,
					recurring: p.recurring ? { interval_count: 1, trial_period_days: null, ...p.recurring } : null,
				};
				store.prices.set(price.id, price);
				return price;
			}),
		update: async (id: string, p: Obj) =>
			self.call("prices.update", [id, p], undefined, () => {
				const price = store.prices.get(id);
				if (!price) throw new Error(`No such price: ${id}`);
				Object.assign(price, p);
				return price;
			}),
		retrieve: async (id: string) => store.prices.get(id),
		list: (p: Obj) => {
			self.calls.push({ method: "prices.list", args: [p] });
			let rows = [...store.prices.values()];
			if (p?.active !== undefined) rows = rows.filter((r) => r.active === p.active);
			if (p?.lookup_keys) rows = rows.filter((r) => p.lookup_keys.includes(r.lookup_key));
			if (p?.expand?.includes("data.product")) rows = rows.map((r) => ({ ...r, product: store.products.get(r.product) ?? r.product }));
			const page = { data: rows, has_more: false };
			return Object.assign(Promise.resolve(page), {
				async *[Symbol.asyncIterator]() {
					yield* rows;
				},
			});
		},
	});
	self.coupons = Object.assign(f.coupons, {
		create: async (p: Obj, o?: Obj) =>
			self.call("coupons.create", [p], o, () => {
				const c = { id: self.id("coupon"), object: "coupon", ...p };
				f.coupons.set(c.id, c);
				return c;
			}),
	});
	self.promotionCodes = Object.assign(f.promos, {
		create: async (p: Obj, o?: Obj) =>
			self.call("promotionCodes.create", [p], o, () => {
				const c = { id: self.id("promo"), object: "promotion_code", active: true, times_redeemed: 0, ...p };
				f.promos.set(c.id, c);
				return c;
			}),
		update: async (id: string, p: Obj) =>
			self.call("promotionCodes.update", [id, p], undefined, () => Object.assign(f.promos.get(id)!, p)),
		retrieve: async (id: string) => f.promos.get(id),
	});
	self.subscriptions = Object.assign(f.subs, {
		retrieve: async (id: string) => {
			const s = f.subs.get(id);
			if (!s) throw new Error(`No such subscription: ${id}`);
			return structuredClone(s);
		},
		update: async (id: string, p: Obj) =>
			self.call("subscriptions.update", [id, p], undefined, () => {
				const s = f.subs.get(id);
				if (!s) throw new Error(`No such subscription: ${id}`);
				if (p.items) {
					for (const it of p.items) {
						const item = s.items.data.find((x: Obj) => x.id === it.id);
						if (item && it.price) item.price = structuredClone(store.prices.get(it.price));
						if (item && it.quantity) item.quantity = it.quantity;
					}
				}
				const { items: _i, proration_behavior: _p, ...rest } = p;
				Object.assign(s, rest);
				if (p.cancel_at_period_end !== undefined) s.cancel_at_period_end = p.cancel_at_period_end;
				return structuredClone(s);
			}),
		list: (p: Obj) => {
			const rows = [...f.subs.values()].filter((s) => !p?.customer || s.customer === p.customer).map((s) => structuredClone(s));
			return Object.assign(Promise.resolve({ data: rows, has_more: false }), {
				async *[Symbol.asyncIterator]() {
					yield* rows;
				},
			});
		},
		cancel: async (id: string) =>
			self.call("subscriptions.cancel", [id], undefined, () => {
				const s = f.subs.get(id)!;
				s.status = "canceled";
				s.ended_at = Math.floor(Date.now() / 1000);
				return structuredClone(s);
			}),
	});
	const endpoints = new Map<string, Obj>();
	self.endpoints = endpoints;
	self.webhookEndpoints = {
		create: async (p: Obj) =>
			self.call("webhookEndpoints.create", [p], undefined, () => {
				const ep = { id: self.id("we"), object: "webhook_endpoint", secret: `whsec_fake${self.seq}`, status: "enabled", ...p };
				endpoints.set(ep.id, ep);
				return ep;
			}),
		del: async (id: string) => self.call("webhookEndpoints.del", [id], undefined, () => (endpoints.delete(id), { id, deleted: true })),
		list: (p: Obj) => {
			self.calls.push({ method: "webhookEndpoints.list", args: [p] });
			if (self.failNext === "webhookEndpoints.list") {
				self.failNext = null;
				return Object.assign(Promise.reject(new Error("permission denied")), {
					async *[Symbol.asyncIterator]() {
						throw new Error("permission denied");
					},
				});
			}
			const rows = [...endpoints.values()].map(({ secret: _s, ...rest }) => rest);
			return Object.assign(Promise.resolve({ data: rows, has_more: false }), {
				async *[Symbol.asyncIterator]() {
					yield* rows;
				},
			});
		},
	};
	return f as FakeStripe & { client: Stripe };
}

/** Adds a subscription to the fake, as Stripe would after a checkout. */
export function addSubscription(
	f: FakeStripe,
	input: { id?: string; customer: string; priceId: string; status?: string; quantity?: number; periodEnd?: number; trialEnd?: number | null; discounts?: Obj[]; cancelAtPeriodEnd?: boolean; startDate?: number },
): Obj {
	const price = f.prices.get(input.priceId);
	if (!price) throw new Error(`unknown price ${input.priceId}`);
	const sub = {
		id: input.id ?? `sub_${f.subs.size + 1}`,
		object: "subscription",
		customer: input.customer,
		status: input.status ?? "active",
		cancel_at_period_end: !!input.cancelAtPeriodEnd,
		canceled_at: null,
		ended_at: null,
		start_date: input.startDate ?? 1_794_000_000,
		trial_end: input.trialEnd ?? null,
		discounts: input.discounts ?? [],
		items: { data: [{ id: `si_${f.subs.size + 1}`, quantity: input.quantity ?? 1, current_period_end: input.periodEnd ?? 1_796_000_000, price: structuredClone(price) }] },
	};
	f.subs.set(sub.id, sub);
	return sub;
}
