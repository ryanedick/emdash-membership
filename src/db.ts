/**
 * The minimal slice of Cloudflare D1 this package uses. Declared structurally
 * so the package doesn't depend on @cloudflare/workers-types, and so tests can
 * pass any compatible implementation.
 */
export interface DbStatement {
	bind(...values: unknown[]): DbStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}

export interface Db {
	prepare(query: string): DbStatement;
	batch(statements: DbStatement[]): Promise<unknown[]>;
}

/**
 * Schema migrations, applied in order. Never edit a shipped migration; add a
 * new one. Every statement in a migration runs in one D1 batch (one transaction).
 */
const MIGRATIONS: string[][] = [
	// 1: members, login links, sessions
	[
		`CREATE TABLE IF NOT EXISTS mbr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS mbr_members (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			plan TEXT NOT NULL DEFAULT 'free',
			created_at INTEGER NOT NULL,
			last_login_at INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_login_tokens (
			token_hash TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			next_path TEXT,
			ip TEXT,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			used_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_login_tokens_email ON mbr_login_tokens (email, created_at)`,
		`CREATE INDEX IF NOT EXISTS mbr_login_tokens_ip ON mbr_login_tokens (ip, created_at)`,
		`CREATE TABLE IF NOT EXISTS mbr_sessions (
			token_hash TEXT PRIMARY KEY,
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			user_agent TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_sessions_member ON mbr_sessions (member_id)`,
		`CREATE INDEX IF NOT EXISTS mbr_sessions_expires ON mbr_sessions (expires_at)`,
	],
	// 2: Stripe billing. Separate tables (no ALTERs) so the migration is idempotent.
	[
		`CREATE TABLE IF NOT EXISTS mbr_billing (
			member_id TEXT PRIMARY KEY REFERENCES mbr_members (id) ON DELETE CASCADE,
			stripe_customer_id TEXT UNIQUE,
			early_member INTEGER NOT NULL DEFAULT 0,
			early_access_at INTEGER,
			early_access_revoked_at INTEGER,
			grace_ends_at INTEGER,
			risk_flag TEXT,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_subscriptions (
			id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			status TEXT NOT NULL,
			price_id TEXT,
			lookup_key TEXT,
			current_period_end INTEGER,
			cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_subscriptions_member ON mbr_subscriptions (member_id)`,
		`CREATE TABLE IF NOT EXISTS mbr_checkouts (
			session_id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			payment_intent_id TEXT,
			status TEXT NOT NULL DEFAULT 'open',
			created_at INTEGER NOT NULL,
			completed_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_checkouts_pi ON mbr_checkouts (payment_intent_id)`,
		`CREATE TABLE IF NOT EXISTS mbr_stripe_events (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			received_at INTEGER NOT NULL
		)`,
	],
	// 3: one row per lifecycle email sent, so each goes out exactly once
	[
		`CREATE TABLE IF NOT EXISTS mbr_notices (
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			sent_at INTEGER NOT NULL,
			PRIMARY KEY (member_id, kind)
		)`,
	],
	// 4: comp grants (time-limited Pro outside Stripe) and a plan-change log
	[
		`CREATE TABLE IF NOT EXISTS mbr_grants (
			id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			source_key TEXT NOT NULL UNIQUE,
			reason TEXT,
			starts_at INTEGER NOT NULL,
			ends_at INTEGER NOT NULL,
			revoked_at INTEGER,
			settled_at INTEGER,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_grants_member ON mbr_grants (member_id, ends_at)`,
		`CREATE INDEX IF NOT EXISTS mbr_grants_unsettled ON mbr_grants (settled_at, ends_at)`,
		`CREATE TABLE IF NOT EXISTS mbr_plan_changes (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			member_id TEXT NOT NULL,
			email TEXT NOT NULL,
			plan TEXT NOT NULL,
			changed_at INTEGER NOT NULL
		)`,
		// Backfill: members who are already Pro, so a consumer starting now sees them.
		`INSERT INTO mbr_plan_changes (member_id, email, plan, changed_at)
			SELECT id, email, plan, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM mbr_members WHERE plan = 'pro'`,
	],
	// 5: plans and entitlements, prices and coupons (synced to Stripe), revenue
	// history, an email outbox and settings. Built-in plans: free and pro.
	[
		`CREATE TABLE IF NOT EXISTS mbr_plans (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			entitlements TEXT NOT NULL DEFAULT '[]',
			paid INTEGER NOT NULL DEFAULT 1,
			visible INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0,
			stripe_product_id TEXT,
			archived_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`INSERT INTO mbr_plans (id, name, description, entitlements, paid, sort_order, created_at, updated_at)
			VALUES ('free', 'Free', NULL, '[]', 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
			ON CONFLICT (id) DO NOTHING`,
		`INSERT INTO mbr_plans (id, name, description, entitlements, paid, sort_order, created_at, updated_at)
			VALUES ('pro', 'Pro', NULL, '["pro"]', 1, 10, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
			ON CONFLICT (id) DO NOTHING`,
		`CREATE TABLE IF NOT EXISTS mbr_prices (
			id TEXT PRIMARY KEY,
			plan_id TEXT NOT NULL REFERENCES mbr_plans (id),
			lookup_key TEXT NOT NULL UNIQUE,
			stripe_price_id TEXT UNIQUE,
			kind TEXT NOT NULL,
			amount INTEGER NOT NULL,
			currency TEXT NOT NULL,
			interval TEXT,
			interval_count INTEGER NOT NULL DEFAULT 1,
			trial_days INTEGER NOT NULL DEFAULT 0,
			grants_early_access INTEGER NOT NULL DEFAULT 0,
			max_members INTEGER,
			available_until INTEGER,
			gift_days INTEGER NOT NULL DEFAULT 0,
			per_seat INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			sync_error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_prices_plan ON mbr_prices (plan_id)`,
		`CREATE TABLE IF NOT EXISTS mbr_member_access (
			member_id TEXT PRIMARY KEY REFERENCES mbr_members (id) ON DELETE CASCADE,
			plans TEXT NOT NULL DEFAULT '[]',
			entitlements TEXT NOT NULL DEFAULT '[]',
			updated_at INTEGER NOT NULL
		)`,
		`INSERT INTO mbr_member_access (member_id, plans, entitlements, updated_at)
			SELECT id, CASE WHEN plan = 'pro' THEN '["pro"]' ELSE '[]' END, CASE WHEN plan = 'pro' THEN '["pro"]' ELSE '[]' END,
				CAST(strftime('%s', 'now') AS INTEGER) * 1000
			FROM mbr_members WHERE true
			ON CONFLICT (member_id) DO NOTHING`,
		`CREATE TABLE IF NOT EXISTS mbr_grant_plans (
			grant_id TEXT PRIMARY KEY REFERENCES mbr_grants (id) ON DELETE CASCADE,
			plan_id TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_subscription_terms (
			subscription_id TEXT PRIMARY KEY REFERENCES mbr_subscriptions (id) ON DELETE CASCADE,
			plan_id TEXT,
			amount INTEGER,
			currency TEXT,
			interval TEXT,
			interval_count INTEGER,
			quantity INTEGER NOT NULL DEFAULT 1,
			discount_pct REAL,
			discount_amount INTEGER,
			mrr INTEGER NOT NULL DEFAULT 0,
			trial_end INTEGER,
			started_at INTEGER,
			canceled_at INTEGER,
			ended_at INTEGER,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_mrr_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			member_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			at INTEGER NOT NULL,
			currency TEXT NOT NULL,
			mrr_before INTEGER NOT NULL,
			mrr_after INTEGER NOT NULL,
			kind TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_mrr_events_at ON mbr_mrr_events (at)`,
		`CREATE TABLE IF NOT EXISTS mbr_coupons (
			id TEXT PRIMARY KEY,
			code TEXT NOT NULL UNIQUE,
			stripe_coupon_id TEXT,
			stripe_promotion_code_id TEXT UNIQUE,
			percent_off REAL,
			amount_off INTEGER,
			currency TEXT,
			duration TEXT NOT NULL,
			duration_months INTEGER,
			max_redemptions INTEGER,
			expires_at INTEGER,
			first_time_only INTEGER NOT NULL DEFAULT 0,
			times_redeemed INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_outbox (
			id TEXT PRIMARY KEY,
			dedupe_key TEXT NOT NULL UNIQUE,
			member_id TEXT,
			kind TEXT NOT NULL,
			to_email TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			send_after INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			sent_at INTEGER,
			last_error TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_outbox_due ON mbr_outbox (sent_at, send_after)`,
		`CREATE TABLE IF NOT EXISTS mbr_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		// Access rules: what a page needs, with free windows, free flags and drip
		`CREATE TABLE IF NOT EXISTS mbr_access_rules (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			target_type TEXT NOT NULL,
			target TEXT NOT NULL,
			requirement TEXT NOT NULL DEFAULT 'entitlement',
			entitlement TEXT,
			free_date_field TEXT,
			free_hours INTEGER NOT NULL DEFAULT 0,
			free_flag_field TEXT,
			drip_days INTEGER NOT NULL DEFAULT 0,
			locked_view TEXT NOT NULL DEFAULT 'teaser',
			teaser_blocks INTEGER NOT NULL DEFAULT 2,
			redirect_to TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		// Profile fields defined by staff, and members' answers
		`CREATE TABLE IF NOT EXISTS mbr_profile_fields (
			key TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			type TEXT NOT NULL,
			options TEXT NOT NULL DEFAULT '[]',
			required INTEGER NOT NULL DEFAULT 0,
			at_signup INTEGER NOT NULL DEFAULT 0,
			sort_order INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_profile_values (
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (member_id, key)
		)`,
		// Cancellations: why people leave, what they were offered, what they did
		`CREATE TABLE IF NOT EXISTS mbr_cancellations (
			id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL,
			subscription_id TEXT,
			reason TEXT NOT NULL,
			comment TEXT,
			offer TEXT,
			outcome TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_cancellations_at ON mbr_cancellations (created_at)`,
		// Gifts: a paid code that gives someone time on a plan
		`CREATE TABLE IF NOT EXISTS mbr_gifts (
			id TEXT PRIMARY KEY,
			code TEXT NOT NULL UNIQUE,
			price_lookup_key TEXT NOT NULL,
			plan_id TEXT NOT NULL,
			days INTEGER NOT NULL,
			buyer_member_id TEXT,
			buyer_email TEXT NOT NULL,
			recipient_email TEXT,
			recipient_name TEXT,
			message TEXT,
			deliver_at INTEGER,
			checkout_session_id TEXT UNIQUE,
			payment_intent_id TEXT,
			status TEXT NOT NULL,
			delivered_at INTEGER,
			redeemed_at INTEGER,
			redeemed_member_id TEXT,
			created_at INTEGER NOT NULL
		)`,
		// Teams: one payer, many seats
		`CREATE TABLE IF NOT EXISTS mbr_teams (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner_member_id TEXT NOT NULL,
			plan_id TEXT NOT NULL,
			seats INTEGER NOT NULL,
			subscription_id TEXT UNIQUE,
			join_domain TEXT,
			invite_token TEXT NOT NULL UNIQUE,
			checkout_session_id TEXT UNIQUE,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_team_members (
			team_id TEXT NOT NULL REFERENCES mbr_teams (id) ON DELETE CASCADE,
			email TEXT NOT NULL,
			member_id TEXT,
			role TEXT NOT NULL DEFAULT 'member',
			status TEXT NOT NULL,
			invited_at INTEGER NOT NULL,
			joined_at INTEGER,
			PRIMARY KEY (team_id, email)
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_team_members_member ON mbr_team_members (member_id)`,
		// Protected downloads (files in R2) and who fetched them
		`CREATE TABLE IF NOT EXISTS mbr_downloads (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT,
			r2_key TEXT NOT NULL,
			filename TEXT NOT NULL,
			entitlement TEXT,
			limit_per_member INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_download_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			download_id TEXT NOT NULL,
			member_id TEXT NOT NULL,
			at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_download_log_member ON mbr_download_log (download_id, member_id)`,
		// Event log (feeds outbound webhooks and the admin timeline)
		`CREATE TABLE IF NOT EXISTS mbr_events (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			member_id TEXT,
			data TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_events_member ON mbr_events (member_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS mbr_events_at ON mbr_events (created_at)`,
		`CREATE TABLE IF NOT EXISTS mbr_webhooks (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			secret TEXT NOT NULL,
			events TEXT NOT NULL DEFAULT '[]',
			active INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_webhook_deliveries (
			id TEXT PRIMARY KEY,
			webhook_id TEXT NOT NULL REFERENCES mbr_webhooks (id) ON DELETE CASCADE,
			event_id TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_status INTEGER,
			last_error TEXT,
			delivered_at INTEGER,
			created_at INTEGER NOT NULL,
			UNIQUE (webhook_id, event_id)
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_webhook_deliveries_due ON mbr_webhook_deliveries (delivered_at, next_attempt_at)`,
		// Staff notes and an audit trail of staff actions
		`CREATE TABLE IF NOT EXISTS mbr_notes (
			id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL REFERENCES mbr_members (id) ON DELETE CASCADE,
			author TEXT,
			body TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mbr_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			actor TEXT,
			action TEXT NOT NULL,
			member_id TEXT,
			detail TEXT,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS mbr_audit_member ON mbr_audit (member_id, created_at)`,
	],
];

const ready = new WeakMap<Db, Promise<void>>();

/** Brings the schema up to date once per isolate per database. */
export function ensureSchema(db: Db): Promise<void> {
	let p = ready.get(db);
	if (!p) {
		p = migrate(db).catch((err) => {
			ready.delete(db); // retry on the next request instead of caching the failure
			throw err;
		});
		ready.set(db, p);
	}
	return p;
}

async function migrate(db: Db): Promise<void> {
	await db.prepare(`CREATE TABLE IF NOT EXISTS mbr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
	const row = await db.prepare(`SELECT value FROM mbr_meta WHERE key = 'schema_version'`).first<{ value: string }>();
	let version = row ? Number(row.value) : 0;
	while (version < MIGRATIONS.length) {
		const next = version + 1;
		await db.batch([
			...MIGRATIONS[version].map((sql) => db.prepare(sql)),
			db
				.prepare(
					`INSERT INTO mbr_meta (key, value) VALUES ('schema_version', ?)
					 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
				)
				.bind(String(next)),
		]);
		version = next;
	}
}
