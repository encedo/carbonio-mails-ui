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

import { SoapEmailMessagePartObj } from 'types/soap/save-draft';
import { pgpCall } from '../../../../../commons/pgp-bridge';

export type PgpSendParams = {
	senderEmail: string;
	recipientEmails: string[];
	plainText: string;
	richText: string;
	// Standard attachments, encrypted inside the PGP message (encrypt path only).
	attachments?: Array<{ filename: string; contentType: string; base64: string }>;
};

function randomBoundary(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(12)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Build MIME mp[] for a sign-only message.
 * Plain text part is replaced with inline PGP cleartext signature.
 * HTML part is left as-is.
 */
export async function buildSignedMp(params: PgpSendParams): Promise<SoapEmailMessagePartObj[]> {
	const signedPlain: string = await pgpCall('__encedoPgpSignOnly', params);

	return [
		{
			ct: 'multipart/alternative',
			mp: [
				{
					ct: 'text/html',
					body: true,
					content: { _content: params.richText },
				},
				{
					ct: 'text/plain',
					content: { _content: signedPlain },
				},
			],
		},
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
					content: { _content: 'Version: 1\n' },
				},
				{
					ct: 'application/octet-stream',
					cd: 'attachment',
					filename: 'encrypted.asc',
					content: { _content: armoredMessage },
				},
			],
		},
	];
}
