/** 32 random bytes as base64url: the secret part of links and session cookies. */
export function randomToken(bytes = 32): string {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	let bin = "";
	for (const b of buf) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Tokens are stored only as SHA-256 hashes, so a database leak can't be replayed. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
