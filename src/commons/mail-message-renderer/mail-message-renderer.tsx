/*
 * SPDX-FileCopyrightText: 2021 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import React, { memo } from 'react';

import { HtmlMessageRenderer } from './html-message-renderer/html-message-renderer';
import { TextMessageRenderer } from './text-message-renderer/text-message-renderer';
import { EmptyBody, EncryptedMsg } from 'commons/mail-message-renderer/empty-body';
import { PgpMessageView } from './pgp-message-view';
import { MailMessage } from 'types/messages';

type MailMessageRendererProps = {
	message: MailMessage;
};

export const MailMessageRenderer = memo(function MailMessageRenderer({
	message
}: MailMessageRendererProps): JSX.Element {
	const { body, fragment } = message;

	const isPgpEncrypted = message.isPgpEncrypted
		|| body?.contentType === 'application/pgp-encrypted'
		|| body?.contentType?.startsWith('multipart/encrypted');
	const isPgpSigned = message.isPgpSigned
		|| (body?.contentType === 'text/plain' && (body?.content as string | undefined)?.includes('-----BEGIN PGP SIGNED MESSAGE-----'));

	if (isPgpEncrypted || isPgpSigned) {
		return <PgpMessageView message={{ ...message, isPgpEncrypted: !!isPgpEncrypted, isPgpSigned: !!isPgpSigned }} />;
	}
	if (message.isEncrypted) {
		return <EncryptedMsg />;
	}
	if (!body?.content?.length && !fragment) {
		return <EmptyBody />;
	}

	if (body?.contentType === 'text/html') {
		return <HtmlMessageRenderer message={message} />;
	}
	if (body?.contentType === 'text/plain') {
		return <TextMessageRenderer body={body} />;
	}
	return <EmptyBody />;
});
