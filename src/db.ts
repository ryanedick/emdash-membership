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
