/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getPgpPrefs } from 'commons/pgp-prefs';
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

type RecipientStatus = 'trusted' | 'mismatch' | 'available' | 'unavailable';

async function recipientStatus(email: string): Promise<RecipientStatus> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const statusFn = (window as any).__encedoPgpRecipientStatus;
		if (statusFn) return await statusFn(email);
		// Fallback for older pgp-ui builds without the richer status bridge.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const checkWkd = (window as any).__encedoPgpCheckWkd;
		if (checkWkd) return (await checkWkd(email)) ? 'available' : 'unavailable';
		return 'unavailable';
	} catch {
		return 'unavailable';
	}
}

export type UsePgpHandlersReturn = {
	isPgpSign: boolean | undefined;
	isPgpEncrypt: boolean | undefined;
	isHsmUnlocked: boolean;
	encryptStatuses: Record<string, 'checking' | RecipientStatus>;
	handlePgpSignToggle: () => void;
	handlePgpEncryptToggle: () => void;
};

export const usePgpHandlers = (editorId: string): UsePgpHandlersReturn => {
	const { isPgpSign, setIsPgpSign } = useEditorIsPgpSign(editorId);
	const { isPgpEncrypt, setIsPgpEncrypt } = useEditorIsPgpEncrypt(editorId);
	const { recipients } = useEditorRecipients(editorId);
	const [isHsmUnlocked, setIsHsmUnlocked] = useState(false);
	const [encryptStatuses, setEncryptStatuses] = useState<
		Record<string, 'checking' | RecipientStatus>
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
			const next: Record<string, 'checking' | RecipientStatus> = {};
			for (const addr of allRecipients) next[addr] = prev[addr] ?? 'checking';
			return next;
		});

		if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
		checkTimerRef.current = setTimeout(async () => {
			const results = await Promise.allSettled(
				allRecipients.map(async (addr) => ({ addr, status: await recipientStatus(addr) }))
			);
			const next: Record<string, RecipientStatus> = {};
			for (const r of results) {
				if (r.status === 'fulfilled') {
					next[r.value.addr] = r.value.status;
				}
			}
			setEncryptStatuses(next);
		}, 600);

		return () => {
			if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
		};
	}, [recipients]);

	// "Always sign" preference — applied once, as soon as the HSM is unlocked
	const signPrefAppliedRef = useRef(false);
	useEffect(() => {
		if (signPrefAppliedRef.current || !isHsmUnlocked) return;
		signPrefAppliedRef.current = true;
		if (getPgpPrefs().alwaysSign && !isPgpSign) {
			setIsPgpSign(true);
		}
	}, [isHsmUnlocked, isPgpSign, setIsPgpSign]);

	// Turn encrypt off when it becomes unavailable (recipient removed / key gone), and turn it
	// on when the "always encrypt" preference is set and every recipient has a key. An explicit
	// toggle by the user wins over the preference for the rest of the editor's life.
	const encryptToggledByUserRef = useRef(false);
	useEffect(() => {
		const allRecipients = [...recipients.to, ...recipients.cc, ...recipients.bcc].map(
			(r) => r.address
		);
		if (allRecipients.length === 0) {
			setIsPgpEncrypt(false);
			return;
		}
		const allAvailable = allRecipients.every(
			(a) => encryptStatuses[a] === 'available' || encryptStatuses[a] === 'trusted'
		);
		if (!allAvailable) {
			if (isPgpEncrypt) setIsPgpEncrypt(false);
			return;
		}
		if (
			!isPgpEncrypt &&
			!encryptToggledByUserRef.current &&
			isHsmUnlocked &&
			getPgpPrefs().alwaysEncrypt
		) {
			setIsPgpEncrypt(true);
			setIsPgpSign(true); // encryption always signs
		}
	}, [encryptStatuses, isHsmUnlocked, isPgpEncrypt, recipients, setIsPgpEncrypt, setIsPgpSign]);

	// Valid states are: plaintext, Sign, Encrypt&Sign — encryption always signs, so there
	// is no "encrypt without sign". Turning encrypt on forces sign on; turning sign off
	// while encrypting drops back to plaintext.
	const handlePgpSignToggle = useCallback(() => {
		signPrefAppliedRef.current = true;
		const next = !isPgpSign;
		setIsPgpSign(next);
		if (!next && isPgpEncrypt) setIsPgpEncrypt(false);
	}, [isPgpSign, isPgpEncrypt, setIsPgpSign, setIsPgpEncrypt]);

	const handlePgpEncryptToggle = useCallback(() => {
		const allRecipients = [...recipients.to, ...recipients.cc, ...recipients.bcc].map(
			(r) => r.address
		);
		const allAvailable = allRecipients.every(
			(a) => encryptStatuses[a] === 'available' || encryptStatuses[a] === 'trusted'
		);
		if (!allAvailable) return;
		encryptToggledByUserRef.current = true;
		const next = !isPgpEncrypt;
		setIsPgpEncrypt(next);
		if (next) {
			// Encryption implies signing — light up Sign too.
			signPrefAppliedRef.current = true;
			setIsPgpSign(true);
		}
	}, [isPgpEncrypt, setIsPgpEncrypt, setIsPgpSign, recipients, encryptStatuses]);

	return {
		isPgpSign,
		isPgpEncrypt,
		isHsmUnlocked,
		encryptStatuses,
		handlePgpSignToggle,
		handlePgpEncryptToggle
	};
};
