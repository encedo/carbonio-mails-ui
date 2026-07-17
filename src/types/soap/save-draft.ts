/*
 * SPDX-FileCopyrightText: 2021 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ParticipantRoleType } from '@zextras/carbonio-ui-commons';

import { SoapMailMessage } from 'types/soap/soap-mail-message';

export type MailAttachmentParts = {
	mid: string;
	part: string;
};

export type MsgAttach = {
	id: string;
};

export type MailAttachment = {
	mp: Array<MailAttachmentParts>;
	m?: Array<MsgAttach>;
	aid?: string;
};

export type SoapEmailMessagePartObj = {
	part?: string;
	/**	Content Type  */ ct: 'multipart/alternative' | string;
	/**	Size  */ s?: number;
	/**	Content id (for inline images)  */ ci?: string;
	/** Content disposition */ cd?: 'inline' | 'attachment';
	/**	Parts  */ mp?: Array<SoapEmailMessagePartObj>;
	/**	Set if is the body of the message  */ body?: true;
	filename?: string;
	content?: { _content: string };
};

export type SoapEmailInfoObj = {
	/** Address */
	a: string;
	/** Display name */
	d?: string;
	t: ParticipantRoleType;
	isGroup?: 0 | 1;
	p?: string;
};

export type SoapDraftMessageObj = {
	autoSendTime?: number;
	id?: string;
	attach?: MailAttachment;
	su?: { _content: string };
	mp?: Array<SoapEmailMessagePartObj>;
	e?: Array<SoapEmailInfoObj>;
	f?: string;
	did?: string;
	rt?: string;
	origid?: string;
	/**
	 * Upload ID of a raw RFC822 message (FileUploadServlet). When set, SendMsg sends this
	 * message byte-exact and su/mp/e are omitted — used by the PGP RFC 3156 signed path,
	 * the only way to deliver a detached signature without the server re-serialising it.
	 */
	aid?: string;
};

export type SaveDraftRequest = {
	_jsns: 'urn:zimbraMail';
	m: SoapDraftMessageObj;
};

export type SaveDraftResponse = {
	[x: string]: any;
	m?: Array<SoapMailMessage>;
	Fault?: any;
};
