/**
 * Permission relay: forward Claude Code tool-approval prompts to WhatsApp.
 *
 * Claude Code opens its terminal dialog and, in parallel, sends
 * notifications/claude/channel/permission_request. Whichever answer lands
 * first wins — the terminal stays usable throughout.
 *
 * Two answer paths, because WhatsApp has no inline buttons on personal
 * accounts the way Telegram does:
 *   1. A native poll ("✅ Allow" / "❌ Deny") — tappable on the phone.
 *   2. A text verdict ("y <id>" / "n <id>") — always works, and the fallback
 *      when sending the poll fails.
 *
 * This module is transport-agnostic: it takes callbacks and knows nothing
 * about MCP, so server.ts stays the only protocol-aware file.
 */

export interface PermissionRequest {
    request_id: string;
    tool_name: string;
    description: string;
    input_preview: string;
}

export type Verdict = 'allow' | 'deny';

/** A poll we sent, kept so its votes can be decrypted and attributed. */
export interface SentPoll {
    messageId: string;
    /** Raw proto message of the poll, needed to aggregate encrypted votes. */
    pollMessage: unknown;
}

export interface PermissionRelayDeps {
    /** Chats allowed to answer. Group chats are excluded by the caller. */
    recipients: () => string[];
    sendPoll: (jid: string, question: string, options: string[]) => Promise<SentPoll | null>;
    sendText: (jid: string, text: string) => Promise<void>;
    /** Emits notifications/claude/channel/permission back to Claude Code. */
    sendVerdict: (requestId: string, behavior: Verdict) => void;
    log: (message: string) => void;
}

interface Pending {
    request: PermissionRequest;
    createdAt: number;
    /** Chats the prompt went to, so the outcome can be echoed back. */
    jids: string[];
}

/** Requests older than this are dropped; the terminal dialog owns the real timeout. */
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 50;

/** WhatsApp rejects overlong poll questions; keep well under the limit. */
const POLL_QUESTION_MAX = 240;

const ALLOW_LABEL = '✅ Allow';
const DENY_LABEL = '❌ Deny';

/**
 * Verdict typed into the chat. Accepts English and Chinese so the phone
 * keyboard's language doesn't matter.
 */
const TEXT_VERDICT = /^\s*(y|yes|allow|ok|好|允许|同意|n|no|deny|reject|不|拒绝)\s+([a-km-z]{5})\s*$/i;
const ALLOW_WORDS = new Set(['y', 'yes', 'allow', 'ok', '好', '允许', '同意']);

const truncate = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export class PermissionRelay {
    private pending = new Map<string, Pending>();
    /** Poll message id → request id. */
    private polls = new Map<string, string>();
    /** Poll message id → the poll message itself, for vote aggregation. */
    private pollMessages = new Map<string, unknown>();

    constructor(private readonly deps: PermissionRelayDeps) {}

    /** Handle an inbound permission_request from Claude Code. */
    async onRequest(request: PermissionRequest): Promise<void> {
        this.evictStale();

        const jids = this.deps.recipients();
        if (jids.length === 0) {
            // Nobody to ask. Stay silent and let the terminal dialog handle it —
            // answering on the user's behalf would be the wrong call.
            this.deps.log(`permission ${request.request_id}: no allowlisted chat, terminal only`);
            return;
        }

        this.pending.set(request.request_id, { request, createdAt: Date.now(), jids });

        const question = truncate(
            `🔐 ${request.tool_name}${request.description ? ` — ${request.description}` : ''}`,
            POLL_QUESTION_MAX,
        );

        for (const jid of jids) {
            let delivered = false;
            try {
                const sent = await this.deps.sendPoll(jid, question, [ALLOW_LABEL, DENY_LABEL]);
                if (sent?.messageId) {
                    this.polls.set(sent.messageId, request.request_id);
                    this.pollMessages.set(sent.messageId, sent.pollMessage);
                    delivered = true;
                }
            } catch (error) {
                this.deps.log(`permission ${request.request_id}: poll to ${jid} failed: ${String(error)}`);
            }

            // Fall back to a text prompt so the request is never silently lost.
            if (!delivered) {
                await this.deps
                    .sendText(jid, this.textPrompt(request))
                    .catch(error => this.deps.log(`permission ${request.request_id}: text to ${jid} failed: ${String(error)}`));
            }
        }
    }

    /** The poll message ids currently awaiting a vote. */
    isTrackedPoll(messageId: string): boolean {
        return this.polls.has(messageId);
    }

    pollMessageFor(messageId: string): unknown {
        return this.pollMessages.get(messageId);
    }

    /** Resolve a request from a poll vote. Returns true when it was ours. */
    onPollVote(pollMessageId: string, chosenLabels: string[]): boolean {
        const requestId = this.polls.get(pollMessageId);
        if (!requestId) return false;

        const allow = chosenLabels.includes(ALLOW_LABEL);
        const deny = chosenLabels.includes(DENY_LABEL);
        // An empty selection means the voter cleared their choice — wait.
        if (!allow && !deny) return true;

        this.resolve(requestId, allow ? 'allow' : 'deny');
        return true;
    }

    /**
     * Try to read an inbound chat message as a verdict.
     * Returns true when it was consumed and must not reach Claude.
     */
    onInboundText(text: string): boolean {
        const match = TEXT_VERDICT.exec(text);
        if (!match) return false;

        const [, word, requestId] = match;
        if (!this.pending.has(requestId)) return false;

        this.resolve(requestId, ALLOW_WORDS.has(word.toLowerCase()) ? 'allow' : 'deny');
        return true;
    }

    private resolve(requestId: string, behavior: Verdict): void {
        const entry = this.pending.get(requestId);
        if (!entry) return;

        this.pending.delete(requestId);
        for (const [messageId, id] of this.polls) {
            if (id === requestId) {
                this.polls.delete(messageId);
                this.pollMessages.delete(messageId);
            }
        }

        this.deps.sendVerdict(requestId, behavior);
        this.deps.log(`permission ${requestId}: ${behavior}`);

        // Echo the outcome so the chat history shows what was decided and a
        // stale poll doesn't look like it is still waiting.
        const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied';
        for (const jid of entry.jids) {
            void this.deps
                .sendText(jid, `${label} — ${entry.request.tool_name} (${requestId})`)
                .catch(() => {});
        }
    }

    private textPrompt(request: PermissionRequest): string {
        const lines = [`🔐 Permission needed: ${request.tool_name}`];
        if (request.description) lines.push(request.description);
        if (request.input_preview) lines.push('', truncate(request.input_preview, 800));
        lines.push('', `Reply "y ${request.request_id}" to allow, "n ${request.request_id}" to deny.`);
        return lines.join('\n');
    }

    private evictStale(): void {
        const cutoff = Date.now() - PENDING_TTL_MS;
        for (const [id, entry] of this.pending) {
            if (entry.createdAt < cutoff) this.forget(id);
        }
        // Hard cap in case a burst of prompts never gets answered.
        while (this.pending.size >= MAX_PENDING) {
            const oldest = this.pending.keys().next().value;
            if (oldest === undefined) break;
            this.forget(oldest);
        }
    }

    private forget(requestId: string): void {
        this.pending.delete(requestId);
        for (const [messageId, id] of this.polls) {
            if (id === requestId) {
                this.polls.delete(messageId);
                this.pollMessages.delete(messageId);
            }
        }
    }
}
