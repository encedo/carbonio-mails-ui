/*
 * SPDX-FileCopyrightText: 2026 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback } from 'react';

import { useModal, useSnackbar } from '@zextras/carbonio-design-system';
import { ErrorSoapBodyResponse, t } from '@zextras/carbonio-shell-ui';

import { checkSubjectAndAttachment } from '../check-subject-attachment';
import { getErrorSnackbarProps } from './use-error-handler';
import { buildEncryptedMp, buildSignedMp } from './pgp-send';
import { createEditBoard } from '../edit-view-board';
import { EDIT_VIEW_CLOSING_REASONS, EditViewActions, TIMEOUTS } from 'constants/index';
import {
	addEditor,
	deleteEditor,
	getEditor,
	useEditorAttachments,
	useEditorAutoSendTime,
	useEditorDraftSave,
	useEditorSend
} from 'store/editor';
import { EditViewClosingReasons } from 'types/editor';
import { SaveDraftResponse } from 'types/soap/save-draft';

export const useSendHandlers = (
	editorId: string,
	closeController?: () => void
): {
	onSendClick: () => void;
	onSendLaterClick: (scheduledTime: number) => void;
} => {
	const { setAutoSendTime } = useEditorAutoSendTime(editorId);
	const { saveDraft } = useEditorDraftSave(editorId);
	const { send: sendMessage } = useEditorSend(editorId);
	const { savedStandardAttachments, unsavedStandardAttachments } = useEditorAttachments(editorId);
	const createSnackbar = useSnackbar();
	const { createModal, closeModal } = useModal();

	const close = useCallback(
		(reason?: EditViewClosingReasons): void => {
			if (reason !== EDIT_VIEW_CLOSING_REASONS.EXTERNAL_CLOSE_REQUEST) {
				closeController?.();
			}
		},
		[closeController]
	);

	const onSendCountdownTick = useCallback(
		(countdown: number, cancel: () => void): void => {
			createSnackbar({
				key: 'send',
				replace: true,
				severity: 'info',
				label: t('messages.snackbar.sending_mail_in_count', {
					count: countdown,
					defaultValue_one: 'Sending your message in {{count}} second',
					defaultValue_other: 'Sending your message in {{count}} seconds'
				}),
				disableAutoHide: true,
				hideButton: !cancel,
				actionLabel: t('label.undo', 'Undo'),
				onActionClick: (): void => {
					cancel();
					createEditBoard({
						action: EditViewActions.RESUME,
						actionTargetId: editorId
					});
				}
			});
		},
		[createSnackbar, editorId]
	);

	const onSendError = useCallback(
		(error: SaveDraftResponse | ErrorSoapBodyResponse): void => {
			const { message, timeout } = getErrorSnackbarProps(error);
			createSnackbar({
				key: `mail-${editorId}`,
				replace: true,
				severity: 'error',
				label: message,
				autoHideTimeout: timeout,
				hideButton: true
			});
			createEditBoard({
				action: EditViewActions.RESUME,
				actionTargetId: editorId
			});
		},
		[createSnackbar, editorId]
	);

	const onSendComplete = useCallback((): void => {
		createSnackbar({
			key: `mail-${editorId}`,
			replace: true,
			severity: 'success',
			label: t('messages.snackbar.mail_sent', 'Message sent'),
			autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
			hideButton: true
		});
		deleteEditor({ id: editorId });
	}, [createSnackbar, editorId]);

	const onSendClick = useCallback((): void => {
		const onConfirmCallback = async (): Promise<void> => {
			// ── PGP intercept ────────────────────────────────────────────────
			const editor = getEditor({ id: editorId });
			if (editor && (editor.isPgpSign || editor.isPgpEncrypt)) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const hsm = (window as any).__encedoPgpGetHsm?.();
				if (!hsm?.unlocked) {
					createSnackbar({
						key: `pgp-${editorId}`,
						replace: true,
						severity: 'error',
						label: 'HSM is locked — unlock PGP before sending',
						autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
						hideButton: true
					});
					return;
				}

				// Encryption guards — block leaks until proper support lands (PGP roadmap B).
				if (editor.isPgpEncrypt) {
					// #0a: standard attachments are NOT encrypted yet — they would be sent in
					// clear alongside the encrypted body. Block rather than leak them.
					if (savedStandardAttachments.length > 0 || unsavedStandardAttachments.length > 0) {
						createSnackbar({
							key: `pgp-${editorId}`,
							replace: true,
							severity: 'error',
							label: 'Attachments are not encrypted yet — remove them, or send without encryption',
							autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
							hideButton: true
						});
						return;
					}
					// #0c: a single encrypted copy carries every recipient key ID in the PKESK,
					// so a BCC recipient would be revealed to the To/CC recipients. Block BCC.
					if (editor.recipients.bcc.length > 0) {
						createSnackbar({
							key: `pgp-${editorId}`,
							replace: true,
							severity: 'error',
							label: 'BCC is not supported with encryption yet — it would reveal the hidden recipients. Remove BCC.',
							autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
							hideButton: true
						});
						return;
					}
				}

				const { getIdentityDescriptor } = await import('helpers/identities');
				const identity = getIdentityDescriptor(editor.identityId);
				const senderEmail = identity?.fromAddress ?? '';

				const plainText = editor.textProvider?.getCurrentText()?.plainText ?? editor.text?.plainText ?? '';
				const richText  = editor.textProvider?.getCurrentText()?.richText  ?? editor.text?.richText  ?? '';
				const recipientEmails = [
					...editor.recipients.to,
					...editor.recipients.cc,
					...editor.recipients.bcc
				].map((r) => r.address).filter(Boolean);

				const pgpParams = { senderEmail, recipientEmails, plainText, richText };

				try {
					const overrideMp = editor.isPgpEncrypt
						? await buildEncryptedMp(pgpParams)
						: await buildSignedMp(pgpParams);
					addEditor({ id: editorId, editor: { ...editor, pgpOverrideMp: overrideMp } });
				} catch (e) {
					createSnackbar({
						key: `pgp-${editorId}`,
						replace: true,
						severity: 'error',
						label: `PGP failed: ${e instanceof Error ? e.message : String(e)}`,
						autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
						hideButton: true
					});
					return;
				}
			}
			// ── end PGP intercept ─────────────────────────────────────────────

			sendMessage({
				onCountdownTick: onSendCountdownTick,
				onComplete: onSendComplete,
				onError: onSendError
			});
			close(EDIT_VIEW_CLOSING_REASONS.MESSAGE_SENT);
		};
		checkSubjectAndAttachment({
			editorId,
			hasAttachments: savedStandardAttachments.length > 0,
			onConfirmCallback,
			createModal,
			closeModal
		});
	}, [
		close,
		closeModal,
		createModal,
		createSnackbar,
		editorId,
		onSendComplete,
		onSendCountdownTick,
		onSendError,
		savedStandardAttachments.length,
		sendMessage
	]);

	const onSendLaterClick = useCallback(
		(scheduledTime: number): void => {
			const onConfirmCallback = async (): Promise<void> => {
				setAutoSendTime(scheduledTime);
				saveDraft();
				close(EDIT_VIEW_CLOSING_REASONS.MESSAGE_SEND_SCHEDULED);
			};
			checkSubjectAndAttachment({
				editorId,
				hasAttachments: savedStandardAttachments.length > 0,
				onConfirmCallback,
				createModal,
				closeModal
			});
		},
		[
			close,
			closeModal,
			createModal,
			editorId,
			savedStandardAttachments.length,
			saveDraft,
			setAutoSendTime
		]
	);

	return { onSendClick, onSendLaterClick };
};
