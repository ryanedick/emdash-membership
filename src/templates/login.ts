/**
 * The sign-in email. Plain, table-based HTML with inline styles so it renders
 * the same in Gmail, Outlook and Apple Mail, plus a matching text body.
 */

export interface LoginTemplateInput {
	/** Absolute confirm-page URL, token included. */
	url: string;
	expiresInMinutes: number;
	/** Shown in the subject, heading and footer, e.g. "Example Daily". */
	siteName: string;
	/** Public site URL for the footer link. Defaults to the link's origin. */
	siteUrl?: string;
	/** Button colour (CSS hex). */
	accentColor?: string;
}

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

export function renderLoginEmail(input: LoginTemplateInput): RenderedEmail {
	const siteUrl = input.siteUrl ?? new URL(input.url).origin;
	const siteHost = new URL(siteUrl).host;
	const accent = /^#[0-9a-f]{3,8}$/i.test(input.accentColor ?? "") ? input.accentColor! : "#111827";
	const mins = Math.round(input.expiresInMinutes);
	const minutes = `${mins} minute${mins === 1 ? "" : "s"}`;

	const subject = `Your sign-in link for ${input.siteName}`;

	const text = [
		`Sign in to ${input.siteName}`,
		"",
		"Open this link to sign in:",
		input.url,
		"",
		`The link works once and expires in ${minutes}.`,
		"",
		"If you didn't ask to sign in, you can ignore this email. Nobody can sign in without the link.",
		"",
		"—",
		`${input.siteName} · ${siteUrl}`,
	].join("\n");

	const e = escapeHtml;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${e(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your link to sign in to ${e(input.siteName)}. It expires in ${minutes}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#6b7280;">${e(input.siteName)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">Sign in to ${e(input.siteName)}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#374151;">Click the button below to sign in. The link works once and expires in ${minutes}.</p>
</td></tr>
<tr><td align="left" style="padding:0 32px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-radius:6px;background:${accent};">
<a href="${e(input.url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">Sign in</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">Or paste this link into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${e(input.url)}" style="color:#374151;">${e(input.url)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">If you didn't ask to sign in, you can ignore this email. Nobody can sign in without the link.</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9ca3af;"><a href="${e(siteUrl)}" style="color:#9ca3af;">${e(siteHost)}</a></p>
</td></tr>
</table>
</body>
</html>`;

	return { subject, html, text };
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
