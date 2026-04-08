/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useEditorIsPgpEncrypt, useEditorIsPgpSign, useEditorRecipients } from 'store/editor';

// Access Encedo HSM singleton state — reads _singleton directly to avoid
// needing HsmProvider in the mails-ui tree.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHsmSingleton(): any {
	try {
		// carbonio-pgp-ui exposes _singleton via the module — access via registered function
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const getHsm = (window as any).__encedoPgpGetHsm;
		return getHsm ? getHsm() : null;
	} catch {
		return null;
	}
}

async function wkdHasKey(email: string): Promise<boolean> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const checkWkd = (window as any).__encedoPgpCheckWkd;
		if (checkWkd) return checkWkd(email);
		return false;
	} catch {
		return false;
	}
}

export type UsePgpHandlersReturn = {
	isPgpSign: boolean | undefined;
	isPgpEncrypt: boolean | undefined;
	isHsmUnlocked: boolean;
	encryptStatuses: Record<string, 'checking' | 'available' | 'unavailable'>;
	handlePgpSignToggle: () => void;
	handlePgpEncryptToggle: () => void;
};

export const usePgpHandlers = (editorId: string): UsePgpHandlersReturn => {
	const { isPgpSign, setIsPgpSign } = useEditorIsPgpSign(editorId);
	const { isPgpEncrypt, setIsPgpEncrypt } = useEditorIsPgpEncrypt(editorId);
	const { recipients } = useEditorRecipients(editorId);
	const [isHsmUnlocked, setIsHsmUnlocked] = useState(false);
	const [encryptStatuses, setEncryptStatuses] = useState<
		Record<string, 'checking' | 'available' | 'unavailable'>
	>({});
	const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Poll HSM unlock status
	useEffect(() => {
		const check = (): void => {
			const hsm = getHsmSingleton();
			setIsHsmUnlocked(hsm?.unlocked ?? false);
		};
		check();
		const interval = setInterval(check, 2000);
		return () => clearInterval(interval);
	}, []);

	// Check WKD availability for all To+CC recipients (debounced 600ms)
	useEffect(() => {
		const allRecipients = [
			...recipients.to,
			...recipients.cc,
			...recipients.bcc
		].map((r) => r.address).filter(Boolean);

		if (allRecipients.length === 0) {
			setEncryptStatuses({});
			return;
		}

		// Mark all as checking
		setEncryptStatuses((prev) => {
			const next: Record<string, 'checking' | 'available' | 'unavailable'> = {};
			for (const addr of allRecipients) next[addr] = prev[addr] ?? 'checking';
			return next;
		});

		if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
		checkTimerRef.current = setTimeout(async () => {
			const results = await Promise.allSettled(
				allRecipients.map(async (addr) => ({ addr, has: await wkdHasKey(addr) }))
			);
			const next: Record<string, 'available' | 'unavailable'> = {};
			for (const r of results) {
				if (r.status === 'fulfilled') {
					next[r.value.addr] = r.value.has ? 'available' : 'unavailable';
				}
			}
			setEncryptStatuses(next);
		}, 600);

		return () => {
			if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
		};
	}, [recipients]);

	// If encrypt becomes unavailable (recipient removed / key gone), turn off encrypt flag
	useEffect(() => {
		const allRecipients = [...recipients.to, ...recipients.cc, ...recipients.bcc].map(
			(r) => r.address
		);
		if (allRecipients.length === 0) {
			setIsPgpEncrypt(false);
			return;
		}
		const allAvailable = allRecipients.every((a) => encryptStatuses[a] === 'available');
		if (!allAvailable && isPgpEncrypt) {
			setIsPgpEncrypt(false);
		}
	}, [encryptStatuses, isPgpEncrypt, recipients, setIsPgpEncrypt]);

	const handlePgpSignToggle = useCallback(() => {
		setIsPgpSign(!isPgpSign);
	}, [isPgpSign, setIsPgpSign]);

	const handlePgpEncryptToggle = useCallback(() => {
		const allRecipients = [...recipients.to, ...recipients.cc, ...recipients.bcc].map(
			(r) => r.address
		);
		const allAvailable = allRecipients.every((a) => encryptStatuses[a] === 'available');
		if (!allAvailable) return;
		setIsPgpEncrypt(!isPgpEncrypt);
	}, [isPgpEncrypt, setIsPgpEncrypt, recipients, encryptStatuses]);

	return {
		isPgpSign,
		isPgpEncrypt,
		isHsmUnlocked,
		encryptStatuses,
		handlePgpSignToggle,
		handlePgpEncryptToggle
	};
};
