/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * PGP send helpers — sign and/or encrypt outgoing messages via window globals
 * exposed by carbonio-pgp-ui (which owns the encedo-pgp.browser.js bundle).
 *
 * Sign-only:  inline cleartext PGP signature in the plain text part.
 * Encrypt:    RFC 3156 multipart/encrypted (signed+encrypted via HSM).
 */

import { pgpCall } from '../../../../../commons/pgp-bridge';
import { SoapEmailMessagePartObj } from 'types/soap/save-draft';

export type PgpSendParams = {
	senderEmail: string;
	recipientEmails: string[];
	plainText: string;
	richText: string;
	// Standard attachments, encrypted inside the PGP message (encrypt path only).
	attachments?: Array<{ filename: string; contentType: string; base64: string }>;
	// Inline images (cid:) embedded in a multipart/related inside the encrypted body.
	inlineImages?: Array<{
		filename: string;
		contentType: string;
		base64: string;
		contentId: string;
	}>;
	// When set, the subject is carried as an encrypted protected header (memory hole).
	subject?: string;
};

function randomBoundary(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(12)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Build MIME mp[] for a sign-only message.
 *
 * The body is a SINGLE text/plain part holding the inline PGP cleartext signature
 * (-----BEGIN PGP SIGNED MESSAGE-----). It must be the sole body part: when the signed
 * text lived in a multipart/alternative alongside an HTML part, Carbonio's server
 * collapsed the alternative down to the HTML part and dropped the signed text entirely
 * (the signature never reached the recipient). A lone text/plain has nothing to collapse,
 * so the signature survives and PGP-aware clients can verify it. Trade-off: sign-only
 * messages are plain text (no HTML) — inherent to inline PGP; RFC 3156 multipart/signed
 * would keep HTML but is blocked by the same server re-serialization.
 */
export async function buildSignedMp(params: PgpSendParams): Promise<SoapEmailMessagePartObj[]> {
	const signedPlain: string = await pgpCall('__encedoPgpSignOnly', params);

	return [
		{
			ct: 'text/plain',
			body: true,
			content: { _content: signedPlain }
		}
	];
}

/**
 * Build MIME mp[] for an encrypted + signed message — RFC 3156.
 *
 * Structure:
 *   multipart/encrypted; protocol="application/pgp-encrypted"
 *     application/pgp-encrypted  →  "Version: 1"
 *     application/octet-stream   →  -----BEGIN PGP MESSAGE-----
 */
export async function buildEncryptedMp(params: PgpSendParams): Promise<SoapEmailMessagePartObj[]> {
	const armoredMessage: string = await pgpCall('__encedoPgpEncryptAndSign', params);

	const boundary = randomBoundary();
	return [
		{
			ct: `multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
			mp: [
				{
					ct: 'application/pgp-encrypted',
					content: { _content: 'Version: 1\n' }
				},
				{
					ct: 'application/octet-stream',
					cd: 'attachment',
					filename: 'encrypted.asc',
					content: { _content: armoredMessage }
				}
			]
		}
	];
}

export type PgpSignedEmlParams = {
	senderEmail: string;
	senderName?: string;
	to: Array<{ email: string; name?: string }>;
	cc?: Array<{ email: string; name?: string }>;
	subject: string;
	plainText: string;
	richText: string;
	attachments?: Array<{ filename: string; contentType: string; base64: string }>;
	inlineImages?: Array<{
		filename: string;
		contentType: string;
		base64: string;
		contentId: string;
	}>;
};

/**
 * Build a full RFC 3156 multipart/signed message (raw .eml) via carbonio-pgp-ui, which
 * signs it with the HSM. The returned bytes are uploaded and sent verbatim — see
 * uploadRawMime + the editor-transformations aid path.
 */
export async function buildSignedEml(params: PgpSignedEmlParams): Promise<string> {
	return pgpCall('__encedoPgpBuildSignedEml', params);
}

/**
 * Upload a raw RFC822 message to Carbonio's FileUploadServlet and return its upload id (aid).
 * The session cookie authenticates the request (same origin). SendMsg then delivers the
 * uploaded bytes byte-exact via <m aid="…"/>.
 */
export async function uploadRawMime(eml: string): Promise<string> {
	const res = await fetch('/service/upload?fmt=raw,extended', {
		method: 'POST',
		headers: {
			'Content-Type': 'message/rfc822',
			'Content-Disposition': 'attachment; filename="message.eml"'
		},
		body: eml,
		credentials: 'same-origin'
	});
	if (!res.ok) throw new Error(`raw upload failed: HTTP ${res.status}`);
	// Response body is Zimbra's callback form: 200,'null',[{"aid":"…","ct":"message/rfc822",…}]
	const text = await res.text();
	const m = text.match(/"aid"\s*:\s*"([^"]+)"/);
	if (!m) throw new Error(`raw upload: no aid in response (${text.slice(0, 120)})`);
	return m[1];
}
