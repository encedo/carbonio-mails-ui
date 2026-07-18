/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Read-only view of the OpenPGP preferences owned by carbonio-pgp-ui.
 * They live in localStorage (same origin, separate bundle) — the keys below
 * are the contract with `carbonio-pgp-ui/src/lib/pgp-prefs.ts`.
 */

export type PgpPrefs = {
	alwaysSign: boolean;
	alwaysEncrypt: boolean;
	autoDecrypt: boolean;
	/** Hide recipient key IDs (wildcard). When on, BCC is allowed with encryption. */
	wildcard: boolean;
	/**
	 * Sign as RFC 3156 multipart/signed (delivered via upload+SendMsg aid, byte-exact) instead
	 * of inline cleartext. ON by default (richer: keeps HTML, proper PGP/MIME signature).
	 */
	rfc3156Sign: boolean;
	/** Encrypt the Subject via protected headers (outer subject = placeholder). OFF by default. */
	encryptSubject: boolean;
};

const PGP_PREF_KEYS: Record<keyof PgpPrefs, string> = {
	alwaysSign: 'pgp.pref.alwaysSign',
	alwaysEncrypt: 'pgp.pref.alwaysEncrypt',
	autoDecrypt: 'pgp.pref.autoDecrypt',
	wildcard: 'pgp.pref.wildcard',
	rfc3156Sign: 'pgp.pref.rfc3156Sign',
	encryptSubject: 'pgp.pref.encryptSubject'
};

export const getPgpPrefs = (): PgpPrefs => {
	try {
		return {
			alwaysSign: localStorage.getItem(PGP_PREF_KEYS.alwaysSign) === 'true',
			alwaysEncrypt: localStorage.getItem(PGP_PREF_KEYS.alwaysEncrypt) === 'true',
			autoDecrypt: localStorage.getItem(PGP_PREF_KEYS.autoDecrypt) === 'true',
			wildcard: localStorage.getItem(PGP_PREF_KEYS.wildcard) === 'true',
			rfc3156Sign: localStorage.getItem(PGP_PREF_KEYS.rfc3156Sign) !== 'false',
			encryptSubject: localStorage.getItem(PGP_PREF_KEYS.encryptSubject) === 'true'
		};
	} catch {
		return {
			alwaysSign: false,
			alwaysEncrypt: false,
			autoDecrypt: false,
			wildcard: false,
			rfc3156Sign: true,
			encryptSubject: false
		};
	}
};
