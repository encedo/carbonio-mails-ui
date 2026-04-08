/*
 * SPDX-FileCopyrightText: 2026 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Container, Row, Text } from '@zextras/carbonio-design-system';

import { MailMessage } from 'types/messages';

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
		if (part.contentType?.startsWith('multipart/encrypted') || part.ct?.startsWith('multipart/encrypted')) {
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

/** Find inline PGP cleartext in text/plain body. */
function findInlineSigned(message: MailMessage): string | null {
	const plain = message.body?.contentType === 'text/plain' ? message.body.content : null;
	if (plain?.includes('-----BEGIN PGP SIGNED MESSAGE-----')) return plain;
	return null;
}

export const PgpMessageView = ({ message }: PgpMessageViewProps): React.JSX.Element => {
	const [status, setStatus] = useState<PgpStatus>({ state: 'idle' });
	const decryptedRef = useRef<HTMLDivElement>(null);

	const decrypt = useCallback(async () => {
		setStatus({ state: 'decrypting' });
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const pgpDecrypt = (window as any).__encedoPgpDecrypt;
			if (!pgpDecrypt) throw new Error('carbonio-pgp-ui not loaded');

			let armoredOrSigned: string | null = null;
			let mode: 'encrypt' | 'sign' = 'encrypt';

			if (message.isPgpEncrypted) {
				mode = 'encrypt';
				const partNum = findPgpPartNumber(message);
				if (!partNum) throw new Error('Cannot find PGP payload part in message');
				armoredOrSigned = await fetchArmoredMessage(message.id, partNum);
			} else if (message.isPgpSigned) {
				armoredOrSigned = findInlineSigned(message);
				mode = 'sign';
			}

			if (!armoredOrSigned) throw new Error('Could not find PGP payload in message parts');

			const senderEmail = message.participants?.find(p => p.type === 'f')?.address;
			const recipientEmail = message.participants?.find(p => p.type === 't')?.address;

			const result: { html: string; signerEmail: string | null; sigValid: boolean | null } =
				await pgpDecrypt({ armored: armoredOrSigned, mode, senderEmail, recipientEmail });

			setStatus({ state: 'done', ...result });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// If HSM is locked, open unlock modal and retry automatically after unlock
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const requestUnlock = (window as any).__encedoPgpRequestUnlock;
			if (msg.includes('HSM not connected') && requestUnlock) {
				setStatus({ state: 'idle' });
				requestUnlock(() => { decrypt(); });
			} else {
				setStatus({ state: 'error', message: msg });
			}
		}
	}, [message]);

	// Auto-decrypt signed messages (no HSM needed for verify-only)
	useEffect(() => {
		if (message.isPgpSigned && status.state === 'idle') {
			decrypt();
		}
	}, [message.isPgpSigned, status.state, decrypt]);

	// Render decrypted HTML into shadow DOM wrapper
	useEffect(() => {
		if (status.state === 'done' && decryptedRef.current) {
			decryptedRef.current.innerHTML = status.html;
		}
	}, [status]);

	const sigBadge =
		status.state === 'done' ? (
			status.sigValid === true ? (
				<Text color="success" size="small">
					✓ Signature valid — {status.signerEmail ?? 'unknown'}
				</Text>
			) : status.sigValid === false ? (
				<Text color="error" size="small">
					✗ Signature invalid
				</Text>
			) : null
		) : null;

	return (
		<Container crossAlignment="flex-start" gap="8px" padding={{ bottom: 'medium' }}>
			{/* Status banner */}
			<Row
				gap="8px"
				padding={{ all: 'small' }}
				style={{ background: '#f0f4ff', borderRadius: 4, width: '100%' }}
			>
				{message.isPgpEncrypted && (
					<Text size="small" style={{ fontWeight: 600 }}>
						🔒 PGP Encrypted
					</Text>
				)}
				{message.isPgpSigned && !message.isPgpEncrypted && (
					<Text size="small" style={{ fontWeight: 600 }}>
						✍ PGP Signed
					</Text>
				)}
				{sigBadge}
				{status.state === 'decrypting' && <Text size="small">Decrypting…</Text>}
				{status.state === 'error' && (
					<Text color="error" size="small">
						{status.message}
					</Text>
				)}
				{status.state === 'idle' && message.isPgpEncrypted && (
					<Button size="small" label="Decrypt" onClick={decrypt} />
				)}
			</Row>

			{/* Decrypted content */}
			{status.state === 'done' && (
				<div
					ref={decryptedRef}
					style={{ width: '100%', overflow: 'auto' }}
				/>
			)}
		</Container>
	);
};
