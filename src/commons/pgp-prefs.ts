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
};

const PGP_PREF_KEYS: Record<keyof PgpPrefs, string> = {
	alwaysSign: 'pgp.pref.alwaysSign',
	alwaysEncrypt: 'pgp.pref.alwaysEncrypt',
	autoDecrypt: 'pgp.pref.autoDecrypt'
};

export const getPgpPrefs = (): PgpPrefs => {
	try {
		return {
			alwaysSign: localStorage.getItem(PGP_PREF_KEYS.alwaysSign) === 'true',
			alwaysEncrypt: localStorage.getItem(PGP_PREF_KEYS.alwaysEncrypt) === 'true',
			autoDecrypt: localStorage.getItem(PGP_PREF_KEYS.autoDecrypt) === 'true'
		};
	} catch {
		return { alwaysSign: false, alwaysEncrypt: false, autoDecrypt: false };
	}
};
