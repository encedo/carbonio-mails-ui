/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import React, { FC } from 'react';

import { Button, Padding, Text, Tooltip } from '@zextras/carbonio-design-system';

import { usePgpHandlers } from '../edit-utils-hooks/use-pgp-handlers';
import { MailsEditorV2 } from 'types/editor';

type PgpButtonsProps = {
	editorId: MailsEditorV2['id'];
};

export const PgpButtons: FC<PgpButtonsProps> = ({ editorId }) => {
	const {
		isPgpSign,
		isPgpEncrypt,
		isHsmUnlocked,
		encryptStatuses,
		handlePgpSignToggle,
		handlePgpEncryptToggle
	} = usePgpHandlers(editorId);

	const encryptValues = Object.values(encryptStatuses);
	const hasRecipients = encryptValues.length > 0;
	const allAvailable =
		hasRecipients && encryptValues.every((s) => s === 'available' || s === 'trusted');
	// TRUSTED = every recipient's key was deliberately imported into the HSM (not just found live).
	const allTrusted = hasRecipients && encryptValues.every((s) => s === 'trusted');
	const anyChecking = encryptValues.some((s) => s === 'checking');

	const signTooltip = !isHsmUnlocked
		? 'Unlock HSM to enable PGP signing'
		: isPgpSign
			? 'PGP Sign: ON — click to disable'
			: 'Sign message with PGP (HSM)';

	const encryptTooltip = !isHsmUnlocked
		? 'Unlock HSM to enable PGP encryption'
		: !hasRecipients
			? 'Add recipients to enable encryption'
			: anyChecking
				? 'Checking WKD keys…'
				: !allAvailable
					? 'Some recipients have no PGP key in WKD'
					: isPgpEncrypt
						? 'PGP Encrypt: ON — click to disable'
						: 'Encrypt message with PGP (WKD keys)';

	const activeLabel = isPgpEncrypt
		? 'PGP Encrypt & Sign active'
		: isPgpSign
			? 'PGP Sign active'
			: '';

	return (
		<>
			{activeLabel && (
				<Padding right="small">
					<Text color="success" size="small" weight="bold">
						{activeLabel}
						{isPgpEncrypt && allTrusted ? ' · TRUSTED' : ''}
					</Text>
				</Padding>
			)}
			<Tooltip label={signTooltip}>
				<Button
					data-testid="BtnPgpSign"
					type={isPgpSign ? 'default' : 'outlined'}
					size="large"
					color={isPgpSign ? 'success' : 'gray0'}
					icon="Signature"
					onClick={handlePgpSignToggle}
					disabled={!isHsmUnlocked}
				/>
			</Tooltip>
			<Tooltip label={encryptTooltip}>
				<Button
					data-testid="BtnPgpEncrypt"
					type={isPgpEncrypt ? 'default' : 'outlined'}
					size="large"
					color={isPgpEncrypt ? 'success' : 'gray0'}
					icon="LockOutline"
					onClick={handlePgpEncryptToggle}
					disabled={!isHsmUnlocked || !allAvailable || anyChecking}
				/>
			</Tooltip>
		</>
	);
};
