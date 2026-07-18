/*
 * SPDX-FileCopyrightText: 2026 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Container, Row, Text } from '@zextras/carbonio-design-system';
import DOMPurify from 'dompurify';

import { pgpCall } from '../pgp-bridge';
import { getPgpPrefs } from '../pgp-prefs';
import { MailMessage } from 'types/messages';

// Decrypted PGP content never passes through Carbonio's server-side HTML filter, so it must
// be sanitised client-side before it reaches innerHTML — otherwise a crafted encrypted mail
// (e.g. <img src=x onerror=…>) runs script in the webmail origin. Keep inline images
// (data:image/…) but drop scripts, event handlers, javascript: and data:text/html.
const PGP_ALLOWED_URI =
	/^(?:(?:https?|mailto|tel|cid):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
function sanitizePgpHtml(html: string): string {
	return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: PGP_ALLOWED_URI });
}

type PgpStatus =
	| { state: 'idle' }
	| { state: 'decrypting' }
	| { state: 'done'; html: string; signerEmail: string | null; sigValid: boolean | null }
	| { state: 'error'; message: string };

type PgpMessageViewProps = { message: MailMessage };

/**
 * Find the part number of the PGP payload (second part of multipart/encrypted).
 * Returns the SOAP part number (e.g. "2") needed for REST fetch.
 * Accepts application/octet-stream (RFC 3156 strict) and text/plain (Proton/Thunderbird).
 */
function findPgpPartNumber(message: MailMessage): string | null {
	for (const part of (message.parts ?? []) as any[]) {
		if (
			part.contentType?.startsWith('multipart/encrypted') ||
			part.ct?.startsWith('multipart/encrypted')
		) {
			for (const sub of part.parts ?? []) {
				const ct = sub.contentType ?? sub.ct ?? '';
				if ((ct === 'application/octet-stream' || ct === 'text/plain') && (sub.name || sub.part)) {
					return (sub.name ?? sub.part) as string;
				}
			}
		}
	}
	return null;
}

/** Fetch PGP MESSAGE armored text via Carbonio REST (part content not inlined in SOAP). */
async function fetchArmoredMessage(msgId: string, partNum: string): Promise<string> {
	const url = `/service/home/~/?auth=co&id=${encodeURIComponent(msgId)}&part=${encodeURIComponent(partNum)}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch part ${partNum}: HTTP ${res.status}`);
	return res.text();
}

/** Fetch the raw MIME of a message (byte-exact, as received) for detached-signature verify. */
async function fetchRawMessage(msgId: string): Promise<string> {
	const url = `/service/home/~/?auth=co&id=${encodeURIComponent(msgId)}&fmt=raw`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch raw message: HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	let s = '';
	const chunk = 0x8000;
	for (let i = 0; i < buf.length; i += chunk)
		s += String.fromCharCode(...buf.subarray(i, i + chunk));
	return s; // latin1 — each char is exactly one byte
}

/**
 * Extract, from a raw RFC 3156 multipart/signed message, the byte-exact signed part
 * (base64) and the armored detached signature. The signature covers the first body part's
 * canonical MIME (headers + body); the CRLF immediately before the boundary belongs to the
 * boundary, not the signed data.
 */
function extractDetachedSigned(raw: string): { signedB64: string; sig: string } | null {
	const m = raw.match(/multipart\/signed[^]*?boundary="?([^";\r\n]+)"?/i);
	if (!m) return null;
	const delim = `--${m[1].trim()}`;
	const first = raw.indexOf(delim);
	if (first < 0) return null;
	const partStart = raw.indexOf('\n', first) + 1; // after the opening boundary line
	const secondIdx = raw.indexOf(`\n${delim}`, partStart);
	if (secondIdx < 0) return null;
	let end = secondIdx; // at '\n' of "\n--B"
	if (raw[end] === '\n') end--;
	if (raw[end] === '\r') end--; // strip the CRLF that belongs to the boundary
	const signed = raw.slice(partStart, end + 1);
	const sStart = raw.indexOf('-----BEGIN PGP SIGNATURE-----', secondIdx);
	const END = '-----END PGP SIGNATURE-----';
	const sEnd = raw.indexOf(END, sStart);
	if (sStart < 0 || sEnd < 0) return null;
	return { signedB64: btoa(signed), sig: raw.slice(sStart, sEnd + END.length) };
}

/** Find inline PGP cleartext in text/plain body. */
function findInlineSigned(message: MailMessage): string | null {
	const plain = message.body?.contentType === 'text/plain' ? message.body.content : null;
	if (plain?.includes('-----BEGIN PGP SIGNED MESSAGE-----')) return plain;
	return null;
}

/**
 * True if the message carries an RFC 3156 detached PGP signature. Detect the
 * application/pgp-signature part anywhere in the tree — Carbonio's SOAP strips the
 * protocol= param from the parent multipart/signed content-type, so we can't rely on it.
 */
function hasDetachedSignature(message: MailMessage): boolean {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const isSig = (p: any): boolean =>
		(p?.contentType ?? p?.ct ?? '') === 'application/pgp-signature';
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const walk = (parts: any): boolean =>
		Array.isArray(parts) && parts.some((p: any) => isSig(p) || walk(p?.parts ?? p?.mp));
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return walk(message.parts) || ((message.attachments as any[] | undefined) ?? []).some(isSig);
}

export const PgpMessageView = ({ message }: PgpMessageViewProps): React.JSX.Element => {
	const [status, setStatus] = useState<PgpStatus>({ state: 'idle' });
	const decryptedRef = useRef<HTMLDivElement>(null);

	const decrypt = useCallback(async () => {
		setStatus({ state: 'decrypting' });
		try {
			let armoredOrSigned: string | null = null;
			let mode: 'encrypt' | 'sign' = 'encrypt';

			if (message.isPgpEncrypted) {
				mode = 'encrypt';
				const partNum = findPgpPartNumber(message);
				if (!partNum) throw new Error('Cannot find PGP payload part in message');
				armoredOrSigned = await fetchArmoredMessage(message.id, partNum);
			} else if (message.isPgpSigned) {
				mode = 'sign';
				if (hasDetachedSignature(message)) {
					// RFC 3156 detached signature (e.g. Thunderbird): verify over the byte-exact
					// signed part taken from the raw message — no HSM needed.
					const raw = await fetchRawMessage(message.id);
					const extracted = extractDetachedSigned(raw);
					if (!extracted) throw new Error('Could not extract the signed part from the message');
					const senderEmail = message.participants?.find((p) => p.type === 'f')?.address;
					const result: { html: string; signerEmail: string | null; valid: boolean | null } =
						await pgpCall('__encedoPgpVerifyDetached', {
							signedB64: extracted.signedB64,
							armoredSignature: extracted.sig,
							senderEmail
						});
					setStatus({
						state: 'done',
						html: result.html,
						signerEmail: result.signerEmail,
						sigValid: result.valid
					});
					return;
				}
				armoredOrSigned = findInlineSigned(message);
			}

			if (!armoredOrSigned) throw new Error('Could not find PGP payload in message parts');

			const senderEmail = message.participants?.find((p) => p.type === 'f')?.address;
			const recipientEmail = message.participants?.find((p) => p.type === 't')?.address;

			const result: { html: string; signerEmail: string | null; sigValid: boolean | null } =
				await pgpCall('__encedoPgpDecrypt', {
					armored: armoredOrSigned,
					mode,
					senderEmail,
					recipientEmail
				});

			setStatus({ state: 'done', ...result });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// If HSM is locked, open unlock modal and retry automatically after unlock
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const requestUnlock = (window as any).__encedoPgpRequestUnlock;
			if (msg.includes('HSM not connected') && requestUnlock) {
				setStatus({ state: 'idle' });
				requestUnlock(() => {
					decrypt();
				});
			} else {
				setStatus({ state: 'error', message: msg });
			}
		}
	}, [message]);

	// Connect/unlock the HSM: open the in-place unlock modal if the PGP module is
	// mounted, otherwise switch to the PGP section where the user can connect.
	const connectHsm = useCallback(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const requestUnlock = (window as any).__encedoPgpRequestUnlock;
		if (requestUnlock) {
			setStatus({ state: 'idle' });
			requestUnlock(() => {
				decrypt();
			});
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const openSettings = (window as any).__encedoPgpOpenSettings;
		if (openSettings) openSettings();
	}, [decrypt]);

	// Download the raw encrypted PGP blob (encrypted.asc) so it can be decrypted with an
	// external tool (Kleopatra / gpg) — useful for interop testing and for recipients whose
	// private key lives outside the HSM.
	const downloadAsc = useCallback(async () => {
		try {
			const partNum = findPgpPartNumber(message);
			if (!partNum) return;
			const armored = await fetchArmoredMessage(message.id, partNum);
			const blob = new Blob([armored], { type: 'application/pgp-encrypted' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `encrypted-${message.id}.asc`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch {
			/* ignore — best-effort download */
		}
	}, [message]);

	// Drop the previous result if the panel is reused for another message
	const shownIdRef = useRef(message.id);
	useEffect(() => {
		if (shownIdRef.current !== message.id) {
			shownIdRef.current = message.id;
			setStatus({ state: 'idle' });
		}
	}, [message.id]);

	// Auto-decrypt signed messages (no HSM needed for verify-only), and encrypted ones when the
	// user enabled the "auto decrypt" preference. Runs at most once per message: a locked HSM
	// resets the status back to 'idle' while the unlock modal is open, and re-running here would
	// re-open it in a loop.
	const autoDecryptTriedRef = useRef<string | null>(null);
	useEffect(() => {
		if (autoDecryptTriedRef.current === message.id || status.state !== 'idle') return;
		const auto = message.isPgpSigned || (message.isPgpEncrypted && getPgpPrefs().autoDecrypt);
		if (!auto) return;
		autoDecryptTriedRef.current = message.id;
		decrypt();
	}, [message.id, message.isPgpSigned, message.isPgpEncrypted, status.state, decrypt]);

	// Render decrypted HTML — sanitised (see sanitizePgpHtml) since it bypasses the server filter.
	useEffect(() => {
		if (status.state === 'done' && decryptedRef.current) {
			decryptedRef.current.innerHTML = sanitizePgpHtml(status.html);
		}
	}, [status]);

	const sigBadge =
		status.state === 'done' ? (
			status.sigValid === true ? (
				<Text color="success" size="small" style={{ fontWeight: 600 }}>
					✓ Signature valid — {status.signerEmail ?? 'unknown'}
				</Text>
			) : status.sigValid === false ? (
				<Text color="error" size="small" style={{ fontWeight: 600 }}>
					✗ Signature invalid
				</Text>
			) : status.signerEmail ? (
				<Text color="secondary" size="small">
					⚠ Signed by {status.signerEmail} — key unavailable, not verified
				</Text>
			) : null
		) : null;

	// Banner tint reflects the outcome: green when the signature verified, red on
	// failure/error, neutral blue otherwise.
	const bannerBg =
		status.state === 'done' && status.sigValid === true
			? '#e8f5e9'
			: (status.state === 'done' && status.sigValid === false) || status.state === 'error'
				? '#fdecea'
				: '#f0f4ff';

	return (
		<Container crossAlignment="flex-start" gap="8px" padding={{ bottom: 'medium' }}>
			{/* Status banner */}
			<Row
				gap="8px"
				mainAlignment="flex-start"
				padding={{ all: 'small' }}
				style={{
					background: bannerBg,
					borderRadius: 6,
					width: '100%',
					border: '1px solid rgba(0,0,0,0.08)'
				}}
			>
				{message.isPgpEncrypted && (
					<Text size="small" style={{ fontWeight: 600 }}>
						🔒 OpenPGP Encrypted
					</Text>
				)}
				{message.isPgpSigned && !message.isPgpEncrypted && (
					<Text size="small" style={{ fontWeight: 600 }}>
						✍ OpenPGP Signed
					</Text>
				)}
				{sigBadge}
				{status.state === 'decrypting' && <Text size="small">Decrypting…</Text>}
				{status.state === 'error' && /HSM not connected/i.test(status.message) && (
					<>
						<Text color="error" size="small">
							HSM not connected
						</Text>
						<Button size="small" label="Connect HSM" onClick={connectHsm} />
					</>
				)}
				{status.state === 'error' && !/HSM not connected/i.test(status.message) && (
					<Text color="error" size="small">
						{status.message}
					</Text>
				)}
				{status.state === 'idle' && message.isPgpEncrypted && (
					<Button size="small" label="Decrypt" onClick={decrypt} />
				)}
				{message.isPgpEncrypted && (
					<Button size="small" type="outlined" label="Download .asc" onClick={downloadAsc} />
				)}
			</Row>

			{/* Decrypted content — framed like a card so plain-text signed mail reads cleanly */}
			{status.state === 'done' && (
				<div
					style={{
						width: '100%',
						overflow: 'auto',
						border: '1px solid #e0e0e0',
						borderRadius: 6,
						padding: '12px 16px',
						background: '#ffffff',
						boxSizing: 'border-box'
					}}
				>
					<div ref={decryptedRef} />
				</div>
			)}
		</Container>
	);
};
