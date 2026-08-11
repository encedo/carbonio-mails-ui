/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ParticipantRole } from '@zextras/carbonio-ui-commons';
import { act, renderHook, waitFor } from '@testing-library/react';

import { usePgpHandlers } from '../use-pgp-handlers';
import { setupEditorStore } from '__test__/generators/editor-store';
import { generateNewMessageEditor } from 'store/editor/editor-generators';
import { useEditorsStore } from 'store/editor/store';

const editorId = 'pgp-test-editor';

/** Recipients with a PGP key in WKD; anything else is treated as unavailable. */
let recipientsWithKey: Array<string> = [];

const setRecipients = (addresses: Array<string>): void => {
	useEditorsStore.getState().setRecipients(editorId, {
		to: addresses.map((address) => ({ type: ParticipantRole.TO, address })),
		cc: [],
		bcc: []
	});
};

const setHsmUnlocked = (unlocked: boolean): void => {
	(window as unknown as Record<string, unknown>).__encedoPgpGetHsm = (): unknown => ({ unlocked });
};

describe('usePgpHandlers — preferences', () => {
	beforeEach(() => {
		const editor = generateNewMessageEditor();
		editor.id = editorId;
		setupEditorStore({ editors: [editor] });

		localStorage.clear();
		recipientsWithKey = [];
		setHsmUnlocked(true);
		(window as unknown as Record<string, unknown>).__encedoPgpCheckWkd = (
			email: string
		): Promise<boolean> => Promise.resolve(recipientsWithKey.includes(email));
	});

	it('turns signing on when "always sign" is set and the HSM is unlocked', async () => {
		localStorage.setItem('pgp.pref.alwaysSign', 'true');

		const { result } = renderHook(() => usePgpHandlers(editorId));

		await waitFor(() => expect(result.current.isPgpSign).toBe(true));
	});

	it('leaves signing off when "always sign" is set but the HSM is locked', async () => {
		localStorage.setItem('pgp.pref.alwaysSign', 'true');
		setHsmUnlocked(false);

		const { result } = renderHook(() => usePgpHandlers(editorId));

		await waitFor(() => expect(result.current.isHsmUnlocked).toBe(false));
		expect(result.current.isPgpSign).toBeFalsy();
	});

	it('leaves signing off when "always sign" is not set', async () => {
		const { result } = renderHook(() => usePgpHandlers(editorId));

		await waitFor(() => expect(result.current.isHsmUnlocked).toBe(true));
		expect(result.current.isPgpSign).toBeFalsy();
	});

	it('turns encryption on when "always encrypt" is set and every recipient has a key', async () => {
		localStorage.setItem('pgp.pref.alwaysEncrypt', 'true');
		recipientsWithKey = ['alice@example.com', 'bob@example.com'];

		const { result } = renderHook(() => usePgpHandlers(editorId));
		act(() => setRecipients(['alice@example.com', 'bob@example.com']));

		await waitFor(() => expect(result.current.isPgpEncrypt).toBe(true));
	});

	it('leaves encryption off when a recipient has no key', async () => {
		localStorage.setItem('pgp.pref.alwaysEncrypt', 'true');
		recipientsWithKey = ['alice@example.com'];

		const { result } = renderHook(() => usePgpHandlers(editorId));
		act(() => setRecipients(['alice@example.com', 'nokey@example.com']));

		await waitFor(() =>
			expect(result.current.encryptStatuses['nokey@example.com']).toBe('unavailable')
		);
		expect(result.current.isPgpEncrypt).toBeFalsy();
	});

	it('does not re-enable encryption after the user turned it off', async () => {
		localStorage.setItem('pgp.pref.alwaysEncrypt', 'true');
		recipientsWithKey = ['alice@example.com'];

		const { result } = renderHook(() => usePgpHandlers(editorId));
		act(() => setRecipients(['alice@example.com']));
		await waitFor(() => expect(result.current.isPgpEncrypt).toBe(true));

		act(() => result.current.handlePgpEncryptToggle());

		await waitFor(() => expect(result.current.isPgpEncrypt).toBe(false));
		// give the preference effect a chance to fire again
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
		expect(result.current.isPgpEncrypt).toBe(false);
	});
});
