import { DatabaseSync } from "node:sqlite";
import type { Db, DbStatement } from "../src/db.ts";

/** D1-compatible wrapper over node:sqlite, so tests run the real SQL. */
export function sqliteDb(): Db & { raw: DatabaseSync } {
	const raw = new DatabaseSync(":memory:");
	raw.exec("PRAGMA foreign_keys = ON");
	const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
	function stmt(sql: string, values: unknown[] = []): DbStatement & { exec(): unknown } {
		const s: DbStatement & { exec(): unknown } = {
			bind: (...v: unknown[]) => stmt(sql, v),
			async first<T>() {
				const r = raw.prepare(sql).all(...(values.map(norm) as never[]));
				return (r[0] ?? null) as T | null;
			},
			async all<T>() {
				return { results: raw.prepare(sql).all(...(values.map(norm) as never[])) as T[] };
			},
			async run() {
				return s.exec();
			},
			exec() {
				if (/\bRETURNING\b/i.test(sql)) {
					const rows = raw.prepare(sql).all(...(values.map(norm) as never[]));
					return { meta: { changes: rows.length }, results: rows };
				}
				const r = raw.prepare(sql).run(...(values.map(norm) as never[]));
				return { meta: { changes: Number(r.changes) } };
			},
		};
		return s;
	}
	return {
		raw,
		prepare: (sql: string) => stmt(sql),
		async batch(statements) {
			raw.exec("BEGIN");
			try {
				const out = statements.map((s) => (s as unknown as { exec(): unknown }).exec());
				raw.exec("COMMIT");
				return out;
			} catch (err) {
				raw.exec("ROLLBACK");
				throw err;
			}
		},
	};
}
