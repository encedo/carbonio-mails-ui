/*
 * SPDX-FileCopyrightText: 2026 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useSnackbar } from '@zextras/carbonio-design-system';
import { t } from '@zextras/carbonio-shell-ui';

import { buildEncryptedMp, buildSignedEml, buildSignedMp, uploadRawMime } from './pgp-send';
import {
	bytesToBase64,
	getPgpAttachmentFile,
	clearPgpAttachmentFile
} from 'commons/pgp-attachment-cache';
import { getPgpPrefs } from 'commons/pgp-prefs';
import { TIMEOUTS } from 'constants/index';
import { composeAttachmentDownloadUrl } from 'helpers/attachments';
import { addEditor, getEditor } from 'store/editor';
import { SavedAttachment, UnsavedAttachment } from 'types/attachments';

type CreateSnackbarFn = ReturnType<typeof useSnackbar>;

type PgpAttachmentData = { filename: string; contentType: string; base64: string };
type PgpInlineImageData = PgpAttachmentData & { contentId: string };

/**
 * Point every inline <img> at its cid: URL so it resolves against the embedded image
 * part on the recipient side. TinyMCE keeps the cid in pnsrc/data-src/data-mce-src and
 * the Lexical ImageNode exports it as data-pnsrc/data-mce-src;
 * the live src may be a blob:/service URL that only works in the sender's own session
 * (a bare service URL shows as a broken image in ProtonMail, etc.).
 */
function rewriteInlineImagesToCid(html: string): string {
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		doc.querySelectorAll('img').forEach((img) => {
			const cid = ['pnsrc', 'data-pnsrc', 'data-src', 'data-mce-src']
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
		if (part.isInline && part.contentId)
			inlineImages.push({ filename, contentType, base64, contentId: part.contentId });
		else attachments.push({ filename, contentType, base64 });
	};
	for (const a of saved) {
		// eslint-disable-next-line no-await-in-loop
		const res = await fetch(composeAttachmentDownloadUrl(a));
		if (!res.ok) throw new Error(`could not read attachment "${a.filename}" (HTTP ${res.status})`);
		// eslint-disable-next-line no-await-in-loop
		const bytes = new Uint8Array(await res.arrayBuffer());
		add(
			a,
			bytesToBase64(bytes),
			a.filename || 'attachment',
			a.contentType || 'application/octet-stream'
		);
	}
	for (const a of unsaved) {
		const file = a.uploadId ? getPgpAttachmentFile(a.uploadId) : undefined;
		if (!file)
			throw new Error(`attachment "${a.filename}" is not available — remove and re-attach it`);
		// eslint-disable-next-line no-await-in-loop
		const bytes = new Uint8Array(await file.arrayBuffer());
		add(
			a,
			bytesToBase64(bytes),
			a.filename || file.name,
			a.contentType || file.type || 'application/octet-stream'
		);
	}
	return { attachments, inlineImages };
}

/**
 * Apply PGP to the message staged in the editor, so that the regular send path
 * delivers the signed/encrypted result.
 *
 * Shared by both compose views (Lexical and legacy): it reads the body and the
 * attachments straight from the editor store, which both editors keep current.
 *
 * Returns false when the send must be aborted (HSM locked, unreadable
 * attachment, ...); a snackbar explaining why has already been shown. Messages
 * with no PGP option selected return true untouched.
 */
export const preparePgpSend = async ({
	editorId,
	createSnackbar
}: {
	editorId: string;
	createSnackbar: CreateSnackbarFn;
}): Promise<boolean> => {
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
			return false;
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
				label:
					'BCC is not supported with encryption yet — it would reveal the hidden recipients. Remove BCC.',
				autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
				hideButton: true
			});
			return false;
		}

		const { getIdentityDescriptor } = await import('helpers/identities');
		const identity = getIdentityDescriptor(editor.identityId);
		const senderEmail = identity?.fromAddress ?? '';

		const plainText =
			editor.textProvider?.getCurrentText()?.plainText ?? editor.text?.plainText ?? '';
		// Rewrite inline-image <img src="/service/…"> to cid: refs so they resolve against
		// the embedded image parts on the recipient side (a bare service URL only works in
		// the sender's own authenticated session — e.g. broken in ProtonMail).
		const richText = rewriteInlineImagesToCid(
			editor.textProvider?.getCurrentText()?.richText ?? editor.text?.richText ?? ''
		);
		const recipientEmails = [
			...editor.recipients.to,
			...editor.recipients.cc,
			...editor.recipients.bcc
		]
			.map((r) => r.address)
			.filter(Boolean);

		// RFC 3156 multipart/signed (built client-side, delivered byte-exact via upload+aid)
		// applies to sign-only when the preference is on and there is no BCC. With BCC we
		// fall back to the inline path, which routes hidden recipients through the normal
		// SOAP envelope (the aid path would need per-recipient sends to hide them).
		const useRfc3156Sign =
			!!editor.isPgpSign &&
			!editor.isPgpEncrypt &&
			getPgpPrefs().rfc3156Sign &&
			editor.recipients.bcc.length === 0;

		let pgpAttachments: Array<PgpAttachmentData> = [];
		let pgpInlineImages: Array<PgpInlineImageData> = [];
		// Upload IDs whose retained File we can release once the bytes are folded in.
		const pgpFileUploadIds: string[] = [];
		if (editor.isPgpEncrypt || useRfc3156Sign) {
			// Read attachments FRESH from the editor (not the possibly-stale hook closure).
			const freshSaved = editor.savedAttachments ?? [];
			const freshUnsaved = editor.unsavedAttachments ?? [];
			for (const a of freshUnsaved) if (a.uploadId) pgpFileUploadIds.push(a.uploadId);
			// eslint-disable-next-line no-console
			console.log(
				'[pgp] send: attachments saved=',
				freshSaved.length,
				'unsaved=',
				freshUnsaved.length
			);
			try {
				const gathered = await gatherPgpParts(freshSaved, freshUnsaved);
				pgpAttachments = gathered.attachments;
				pgpInlineImages = gathered.inlineImages;
				// eslint-disable-next-line no-console
				console.log(
					'[pgp] send: gathered',
					pgpAttachments.length,
					'attachment(s),',
					pgpInlineImages.length,
					'inline image(s), b64 chars=',
					[...pgpAttachments, ...pgpInlineImages].reduce((n, a) => n + a.base64.length, 0)
				);
			} catch (e) {
				createSnackbar({
					key: `pgp-${editorId}`,
					replace: true,
					severity: 'error',
					label: `Could not prepare attachments: ${e instanceof Error ? e.message : String(e)}`,
					autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
					hideButton: true
				});
				return false;
			}
		}

		// Subject encryption (protected headers) applies only to encrypted mail: pass the
		// real subject to be embedded inside the ciphertext; the outer subject becomes a
		// placeholder (set on the editor below so editor-transformations emits it in `su`).
		const encryptSubject = !!editor.isPgpEncrypt && getPgpPrefs().encryptSubject && !!editor.subject;
		const pgpParams = {
			senderEmail,
			recipientEmails,
			plainText,
			richText,
			attachments: pgpAttachments,
			inlineImages: pgpInlineImages,
			...(encryptSubject ? { subject: editor.subject } : {})
		};

		try {
			if (useRfc3156Sign) {
				const toRcpts = editor.recipients.to
					.map((r) => ({ email: r.address, name: r.fullName }))
					.filter((r) => r.email);
				const ccRcpts = editor.recipients.cc
					.map((r) => ({ email: r.address, name: r.fullName }))
					.filter((r) => r.email);
				const eml = await buildSignedEml({
					senderEmail,
					senderName: identity?.fromDisplay,
					to: toRcpts,
					cc: ccRcpts,
					subject: editor.subject ?? '',
					plainText,
					richText,
					attachments: pgpAttachments,
					inlineImages: pgpInlineImages
				});
				const aid = await uploadRawMime(eml);
				// eslint-disable-next-line no-console
				console.log(
					'[pgp] send: RFC 3156 signed eml uploaded, aid=',
					aid,
					'bytes=',
					eml.length
				);
				addEditor({
					id: editorId,
					editor: { ...editor, pgpRawUploadAid: aid, pgpOverrideMp: undefined }
				});
			} else {
				const overrideMp = editor.isPgpEncrypt
					? await buildEncryptedMp(pgpParams)
					: await buildSignedMp(pgpParams);
				addEditor({
					id: editorId,
					editor: {
						...editor,
						pgpOverrideMp: overrideMp,
						// Placeholder outer subject when the real one is encrypted inside.
						...(encryptSubject ? { pgpOuterSubject: '...' } : {})
					}
				});
			}
			// Bytes are now folded into the outgoing message — release the retained Files.
			pgpFileUploadIds.forEach(clearPgpAttachmentFile);
		} catch (e) {
			createSnackbar({
				key: `pgp-${editorId}`,
				replace: true,
				severity: 'error',
				label: `PGP failed: ${e instanceof Error ? e.message : String(e)}`,
				autoHideTimeout: TIMEOUTS.SNACKBAR_DEFAULT_TIMEOUT,
				hideButton: true
			});
			return false;
		}
	}

	return true;
};
