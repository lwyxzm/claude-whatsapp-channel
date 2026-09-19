/**
 * Decrypt WhatsApp poll votes.
 *
 * Baileys used to do this itself and emit messages.update with pollUpdates.
 * That block is commented out in lib/Utils/process-message.js — in every
 * published version, 6.7.24 through 7.0.0-rc14 — and carries a "TODO: Remove
 * entirely", so it is a deliberate removal rather than a regression to wait
 * out. getAggregateVotesInPollMessage is still exported but nothing ever feeds
 * it, so a vote now arrives as a raw pollUpdateMessage on messages.upsert and
 * is silently dropped.
 *
 * The primitives it needs are still exported, so this reimplements that path:
 * find the poll the vote belongs to, take its messageSecret, and decrypt.
 *
 * If a future Baileys restores or removes these exports, this is the one file
 * to revisit; everything else falls back to the text verdict on its own.
 */

import { decryptPollVote, getKeyAuthor, jidNormalizedUser } from 'baileys';

export interface PollVote {
    /** Message id of the poll being voted on. */
    pollMessageId: string;
    /** Option names the voter selected. Empty when they cleared their choice. */
    selected: string[];
}

/** The poll creation message as returned by sock.sendMessage. */
type PollCreation = {
    messageContextInfo?: { messageSecret?: Uint8Array | null } | null;
    pollCreationMessage?: { options?: Array<{ optionName?: string | null }> | null } | null;
    pollCreationMessageV2?: { options?: Array<{ optionName?: string | null }> | null } | null;
    pollCreationMessageV3?: { options?: Array<{ optionName?: string | null }> | null } | null;
} | null | undefined;

const optionsOf = (poll: PollCreation): string[] =>
    (poll?.pollCreationMessageV3?.options
        ?? poll?.pollCreationMessageV2?.options
        ?? poll?.pollCreationMessage?.options
        ?? [])
        .map(o => o?.optionName ?? '')
        .filter(Boolean);

/**
 * WhatsApp transmits a vote as SHA-256 hashes of the chosen option names, so
 * the only way back to a label is to hash the poll's own options and match.
 */
const sha256Hex = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Read a vote out of an inbound message.
 *
 * Returns null when the message is not a vote, when the poll it refers to is
 * unknown, or when decryption fails — every one of which means the caller
 * should keep waiting rather than assume an answer.
 */
export async function readPollVote(
    message: any,
    meId: string | undefined,
    findPoll: (pollMessageId: string) => PollCreation,
): Promise<PollVote | null> {
    const update = message?.message?.pollUpdateMessage;
    if (!update?.vote || !meId) return null;

    const creationKey = update.pollCreationMessageKey;
    const pollMessageId = creationKey?.id;
    if (!pollMessageId) return null;

    const poll = findPoll(pollMessageId);
    const pollEncKey = poll?.messageContextInfo?.messageSecret;
    if (!pollEncKey) return null;

    const me = jidNormalizedUser(meId);
    let vote: { selectedOptions?: Uint8Array[] | null };
    try {
        vote = decryptPollVote(update.vote, {
            pollEncKey: pollEncKey as Uint8Array,
            pollCreatorJid: getKeyAuthor(creationKey, me),
            pollMsgId: pollMessageId,
            voterJid: getKeyAuthor(message.key, me),
        });
    } catch {
        return null;
    }

    const chosenHashes = new Set(
        (vote.selectedOptions ?? []).map(o =>
            [...new Uint8Array(o)].map(b => b.toString(16).padStart(2, '0')).join(''),
        ),
    );

    const selected: string[] = [];
    for (const option of optionsOf(poll)) {
        if (chosenHashes.has(await sha256Hex(option))) selected.push(option);
    }

    return { pollMessageId, selected };
}
