/*
 * SPDX-FileCopyrightText: 2026 Encedo <https://www.encedo.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Retains the original File for each uploaded attachment so a PGP-encrypted send
 * can read its bytes client-side and encrypt them inside the message. This avoids
 * ever persisting a plaintext draft to fetch the bytes back (a File is a cheap
 * lazy reference — the bytes are only read at send time). Keyed by uploadId.
 * Cleared when the attachment is removed or the message is sent.
 */

const files = new Map<string, File>();

export function stashPgpAttachmentFile(uploadId: string, file: File): void {
	files.set(uploadId, file);
}

export function getPgpAttachmentFile(uploadId: string): File | undefined {
	return files.get(uploadId);
}

export function clearPgpAttachmentFile(uploadId: string): void {
	files.delete(uploadId);
}

/** Base64-encode bytes in chunks (avoids String.fromCharCode stack limits on large files). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
