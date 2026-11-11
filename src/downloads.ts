/**
 * Protected downloads: files in an R2 bucket (prompt packs, templates, PDFs)
 * that members fetch through your site, checked against an entitlement and
 * an optional per-member limit. Every fetch is logged.
 *
 * The file never gets a public URL: the download route streams it from R2
 * after `fetchDownload` says yes.
 */
import { type Db, ensureSchema } from "./db.ts";
import { emitEvent } from "./events.ts";
import { can } from "./plans.ts";

/** The slice of an R2 bucket binding this module uses. */
export interface DownloadBucket {
	get(key: string): Promise<{ body: ReadableStream; size?: number; httpMetadata?: { contentType?: string } } | null>;
}

export interface Download {
	id: string;
	title: string;
	description: string | null;
	r2Key: string;
	filename: string;
	/** Needed to download; null = any signed-in member */
	entitlement: string | null;
	/** Times each member may download it; 0 = unlimited */
	limitPerMember: number;
	active: boolean;
	sortOrder: number;
	createdAt: number;
}

interface DownloadRow {
	id: string;
	title: string;
	description: string | null;
	r2_key: string;
	filename: string;
	entitlement: string | null;
	limit_per_member: number;
	active: number;
	sort_order: number;
	created_at: number;
}

const toDownload = (r: DownloadRow): Download => ({
	id: r.id,
	title: r.title,
	description: r.description,
	r2Key: r.r2_key,
	filename: r.filename,
	entitlement: r.entitlement,
	limitPerMember: r.limit_per_member,
	active: !!r.active,
	sortOrder: r.sort_order,
	createdAt: r.created_at,
});

export async function listDownloads(db: Db, opts: { activeOnly?: boolean } = {}): Promise<Download[]> {
	await ensureSchema(db);
	const { results } = await db.prepare(`SELECT * FROM mbr_downloads ${opts.activeOnly ? "WHERE active = 1" : ""} ORDER BY sort_order, created_at`).all<DownloadRow>();
	return results.map(toDownload);
}

export async function getDownload(db: Db, id: string): Promise<Download | null> {
	await ensureSchema(db);
	const r = await db.prepare(`SELECT * FROM mbr_downloads WHERE id = ?`).bind(id).first<DownloadRow>();
	return r ? toDownload(r) : null;
}

export type SaveDownloadResult = { ok: true; download: Download } | { ok: false; reason: "invalid_title" | "invalid_key" | "invalid_filename" };

export async function saveDownload(
	db: Db,
	input: { id?: string; title: string; description?: string | null; r2Key: string; filename?: string; entitlement?: string | null; limitPerMember?: number; active?: boolean; sortOrder?: number },
	now = Date.now(),
): Promise<SaveDownloadResult> {
	await ensureSchema(db);
	const title = input.title.trim();
	if (!title || title.length > 160) return { ok: false, reason: "invalid_title" };
	const key = input.r2Key.trim().replace(/^\/+/, "");
	if (!key || key.length > 1024 || key.includes("..")) return { ok: false, reason: "invalid_key" };
	const filename = (input.filename?.trim() || key.split("/").pop() || "").replace(/[^\w.\- ]/g, "_");
	if (!filename) return { ok: false, reason: "invalid_filename" };
	const id = input.id ?? `dl_${crypto.randomUUID().slice(0, 12)}`;
	await db
		.prepare(
			`INSERT INTO mbr_downloads (id, title, description, r2_key, filename, entitlement, limit_per_member, active, sort_order, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET title = excluded.title, description = excluded.description, r2_key = excluded.r2_key,
			   filename = excluded.filename, entitlement = excluded.entitlement, limit_per_member = excluded.limit_per_member,
			   active = excluded.active, sort_order = excluded.sort_order`,
		)
		.bind(
			id,
			title,
			input.description?.trim() || null,
			key,
			filename,
			input.entitlement?.trim() || null,
			Math.max(0, Math.floor(input.limitPerMember ?? 0)),
			input.active === false ? 0 : 1,
			Math.floor(input.sortOrder ?? 0),
			now,
		)
		.run();
	return { ok: true, download: (await getDownload(db, id))! };
}

export async function deleteDownload(db: Db, id: string): Promise<void> {
	await db.prepare(`DELETE FROM mbr_downloads WHERE id = ?`).bind(id).run();
}

export interface DownloadAccess {
	download: Download;
	allowed: boolean;
	/** Downloads left for this member; null = unlimited */
	remaining: number | null;
	reason: "ok" | "sign_in" | "entitlement" | "limit";
}

type Viewer = { id: string; plan?: string; entitlements?: readonly string[] } | null | undefined;

/** What each active download looks like to this member (for a downloads page). */
export async function downloadsFor(db: Db, member: Viewer): Promise<DownloadAccess[]> {
	const items = await listDownloads(db, { activeOnly: true });
	const counts = member
		? new Map(
				(
					await db.prepare(`SELECT download_id, COUNT(*) AS n FROM mbr_download_log WHERE member_id = ? GROUP BY download_id`).bind(member.id).all<{ download_id: string; n: number }>()
				).results.map((r) => [r.download_id, Number(r.n)]),
			)
		: new Map<string, number>();
	return items.map((d) => decide(d, member, counts.get(d.id) ?? 0));
}

function decide(d: Download, member: Viewer, used: number): DownloadAccess {
	const remaining = d.limitPerMember ? Math.max(0, d.limitPerMember - used) : null;
	if (!member) return { download: d, allowed: false, remaining, reason: "sign_in" };
	if (d.entitlement && !can(member, d.entitlement)) return { download: d, allowed: false, remaining, reason: "entitlement" };
	if (remaining === 0) return { download: d, allowed: false, remaining, reason: "limit" };
	return { download: d, allowed: true, remaining, reason: "ok" };
}

export type FetchDownloadResult =
	| { ok: true; download: Download; body: ReadableStream; contentType: string; size?: number }
	| { ok: false; reason: "not_found" | "sign_in" | "entitlement" | "limit" | "missing_file" };

/** Checks access, logs the fetch and opens the file. Stream `body` back with a Content-Disposition attachment header. */
export async function fetchDownload(db: Db, bucket: DownloadBucket, input: { id: string; member: Viewer; now?: number }): Promise<FetchDownloadResult> {
	const d = await getDownload(db, input.id);
	if (!d?.active) return { ok: false, reason: "not_found" };
	const used = input.member
		? Number((await db.prepare(`SELECT COUNT(*) AS n FROM mbr_download_log WHERE download_id = ? AND member_id = ?`).bind(d.id, input.member.id).first<{ n: number }>())?.n ?? 0)
		: 0;
	const access = decide(d, input.member, used);
	if (!access.allowed) return { ok: false, reason: access.reason as "sign_in" | "entitlement" | "limit" };
	const obj = await bucket.get(d.r2Key);
	if (!obj) return { ok: false, reason: "missing_file" };
	const t = input.now ?? Date.now();
	await db.prepare(`INSERT INTO mbr_download_log (download_id, member_id, at) VALUES (?, ?, ?)`).bind(d.id, input.member!.id, t).run();
	await emitEvent(db, "download.fetched", input.member!.id, { downloadId: d.id, title: d.title }, t);
	return { ok: true, download: d, body: obj.body, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream", size: obj.size };
}

/** Totals per download, for the admin. */
export async function downloadStats(db: Db): Promise<Map<string, { total: number; members: number }>> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT download_id, COUNT(*) AS n, COUNT(DISTINCT member_id) AS m FROM mbr_download_log GROUP BY download_id`)
		.all<{ download_id: string; n: number; m: number }>();
	return new Map(results.map((r) => [r.download_id, { total: Number(r.n), members: Number(r.m) }]));
}
