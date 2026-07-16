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
import { bytesToBase64, getPgpAttachmentFile } from 'commons/pgp-attachment-cache';
import { getPgpPrefs } from 'commons/pgp-prefs';
import { composeAttachmentDownloadUrl } from 'helpers/attachments';
import { SavedAttachment, UnsavedAttachment } from 'types/attachments';
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

type PgpAttachmentData = { filename: string; contentType: string; base64: string };
type PgpInlineImageData = PgpAttachmentData & { contentId: string };

/**
 * Point every inline <img> at its cid: URL so it resolves against the embedded image
 * part on the recipient side. The editor keeps the cid in pnsrc/data-src/data-mce-src;
 * the live src may be a blob:/service URL that only works in the sender's own session
 * (a bare service URL shows as a broken image in ProtonMail, etc.).
 */
function rewriteInlineImagesToCid(html: string): string {
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		doc.querySelectorAll('img').forEach((img) => {
			const cid = ['pnsrc', 'data-src', 'data-mce-src']
				.map((attr) => img.getAttribute(attr))
				.find((v) => v && /^cid:/i.test(v));
			if (cid) img.setAttribute('src', cid);
		});
		return doc.body.innerHTML;
	} catch {
		return html;
	}
}

/**
 * Read the bytes of every standard attachment so they can be encrypted INSIDE the
 * PGP message. Saved attachments are fetched over REST; unsaved ones are read from
 * the File kept client-side at attach time. Throws if any attachment's bytes are
 * unavailable — the caller must then abort rather than send it in clear.
 */
async function gatherPgpParts(
	saved: Array<SavedAttachment>,
	unsaved: Array<UnsavedAttachment>
): Promise<{ attachments: Array<PgpAttachmentData>; inlineImages: Array<PgpInlineImageData> }> {
	const attachments: Array<PgpAttachmentData> = [];
	const inlineImages: Array<PgpInlineImageData> = [];
	const add = (
		part: { isInline?: boolean; contentId?: string },
		base64: string,
		filename: string,
		contentType: string
	): void => {
		if (part.isInline && part.contentId) inlineImages.push({ filename, contentType, base64, contentId: part.contentId });
		else attachments.push({ filename, contentType, base64 });
	};
	for (const a of saved) {
		// eslint-disable-next-line no-await-in-loop
		const res = await fetch(composeAttachmentDownloadUrl(a));
		if (!res.ok) throw new Error(`could not read attachment "${a.filename}" (HTTP ${res.status})`);
		// eslint-disable-next-line no-await-in-loop
		const bytes = new Uint8Array(await res.arrayBuffer());
		add(a, bytesToBase64(bytes), a.filename || 'attachment', a.contentType || 'application/octet-stream');
	}
	for (const a of unsaved) {
		const file = a.uploadId ? getPgpAttachmentFile(a.uploadId) : undefined;
		if (!file) throw new Error(`attachment "${a.filename}" is not available — remove and re-attach it`);
		// eslint-disable-next-line no-await-in-loop
		const bytes = new Uint8Array(await file.arrayBuffer());
		add(a, bytesToBase64(bytes), a.filename || file.name, a.contentType || file.type || 'application/octet-stream');
	}
	return { attachments, inlineImages };
}

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
	const { savedStandardAttachments } = useEditorAttachments(editorId);
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

				// #0c: a single encrypted copy carries every recipient's key ID in its PKESK, so a
				// BCC recipient would be revealed to the To/CC recipients. The "wildcard" privacy
				// preference hides the key IDs (allowing BCC) at the cost of Thunderbird/RNP being
				// unable to decrypt; when it's off, block encrypt+BCC to avoid the leak.
				if (editor.isPgpEncrypt && editor.recipients.bcc.length > 0 && !getPgpPrefs().wildcard) {
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

				const { getIdentityDescriptor } = await import('helpers/identities');
				const identity = getIdentityDescriptor(editor.identityId);
				const senderEmail = identity?.fromAddress ?? '';

				const plainText = editor.textProvider?.getCurrentText()?.plainText ?? editor.text?.plainText ?? '';
				// Rewrite inline-image <img src="/service/…"> to cid: refs so they resolve against
				// the embedded image parts on the recipient side (a bare service URL only works in
				// the sender's own authenticated session — e.g. broken in ProtonMail).
				const richText  = rewriteInlineImagesToCid(
					editor.textProvider?.getCurrentText()?.richText ?? editor.text?.richText ?? ''
				);
				const recipientEmails = [
					...editor.recipients.to,
					...editor.recipients.cc,
					...editor.recipients.bcc
				].map((r) => r.address).filter(Boolean);

				let pgpAttachments: Array<PgpAttachmentData> = [];
				let pgpInlineImages: Array<PgpInlineImageData> = [];
				if (editor.isPgpEncrypt) {
					// Read attachments FRESH from the editor (not the possibly-stale hook closure).
					const freshSaved = editor.savedAttachments ?? [];
					const freshUnsaved = editor.unsavedAttachments ?? [];
					// eslint-disable-next-line no-console
					console.log('[pgp] send: attachments saved=', freshSaved.length, 'unsaved=', freshUnsaved.length);
					try {
						const gathered = await gatherPgpParts(freshSaved, freshUnsaved);
						pgpAttachments = gathered.attachments;
						pgpInlineImages = gathered.inlineImages;
						// eslint-disable-next-line no-console
						console.log('[pgp] send: gathered', pgpAttachments.length, 'attachment(s),', pgpInlineImages.length, 'inline image(s), b64 chars=',
							[...pgpAttachments, ...pgpInlineImages].reduce((n, a) => n + a.base64.length, 0));
					} catch (e) {
						createSnackbar({
							key: `pgp-${editorId}`,
							replace: true,
							severity: 'error',
							label: `Could not encrypt attachments: ${e instanceof Error ? e.message : String(e)}`,
							autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
							hideButton: true
						});
						return;
					}
				}

				const pgpParams = { senderEmail, recipientEmails, plainText, richText, attachments: pgpAttachments, inlineImages: pgpInlineImages };

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
