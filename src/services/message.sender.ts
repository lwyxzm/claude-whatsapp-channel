import { WhatsAppService } from './whatsapp.service.js';
import { ImageMessageRequest, MessageOptions, MessageRequest, MessageResult, WhatsAppError } from '../models/whatsapp.types.js';
import { t } from '../i18n.js';
import { appendFileSync } from 'fs';
import { createStoragePaths } from './storage-path.js';

const LOG_FILE = createStoragePaths().logPath;
function fileLog(msg: string) {
    try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [MessageSender] ${msg}\n`); } catch {
        // File logging is best-effort.
    }
}

export class MessageSender {
    private whatsappService: WhatsAppService;

    constructor(whatsappService: WhatsAppService) {
        this.whatsappService = whatsappService;
    }

    /**
     * Pauses execution for the specified time.
     * @param ms Milliseconds to sleep.
     */
    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Waits for the WhatsApp connection to be active.
     * @param timeoutMs Maximum time to wait in milliseconds.
     * @throws {WhatsAppError} If connection is not established within timeout.
     */
    private async waitIfOffline(timeoutMs: number = 30000): Promise<void> {
        const start = Date.now();
        while (this.whatsappService.getStatus() !== 'connected') {
            if (Date.now() - start > timeoutMs) {
                throw new WhatsAppError('TIMEOUT', t('message.sender.timeout'));
            }
            await this.sleep(1000);
        }
    }

    /** Sends a branded text message with retry logic and connection awareness. */
    public async send(request: MessageRequest): Promise<MessageResult> {
        return this.sendContent(
            request.recipientJid,
            { text: `${request.text} π` },
            request.options
        );
    }

    /** Sends an image. The π caption prevents the extension from processing its own message. */
    public async sendImage(request: ImageMessageRequest): Promise<MessageResult> {
        const caption = request.caption?.trim();
        return this.sendContent(
            request.recipientJid,
            {
                image: request.image,
                caption: caption ? `${caption} π` : 'π',
                mimetype: request.mimetype
            },
            request.options
        );
    }

    private async sendContent(
        recipientJid: string,
        content: { text: string } | { image: Buffer; caption: string; mimetype: string },
        options?: MessageOptions
    ): Promise<MessageResult> {
        const isGroup = recipientJid.endsWith('@g.us');
        // Groups need more retries because the first send bootstraps
        // the Signal sender-key session (causes "No sessions" on first attempts)
        const maxRetries = isGroup ? 5 : (options?.maxRetries ?? 3);
        let attempts = 0;
        let lastError: unknown = null;

        while (attempts < maxRetries) {
            attempts++;
            try {
                await this.waitIfOffline();

                const socket = this.whatsappService.getSocket();
                if (!socket) {
                    throw new WhatsAppError('SOCKET_NOT_INIT', t('message.sender.socketNotInitialized'));
                }

                // Pre-load group metadata before sending
                if (isGroup) {
                    await this.whatsappService.prepareGroupSession(recipientJid);
                }

                // Note: Branding π is applied by send/sendImage before reaching sendContent
                const response = await socket.sendMessage(recipientJid, content);
                this.whatsappService.cacheSentMessage(response?.key?.id, response?.message);

                fileLog(`SUCCESS sending to ${recipientJid} on attempt ${attempts}`);
                return {
                    success: true,
                    messageId: response?.key?.id,
                    attempts
                };
            } catch (error: unknown) {
                lastError = error;
                console.error(t('message.sender.attemptFailed', {
                    attempt: attempts,
                    recipientJid,
                    error: error instanceof Error ? error.message : String(error)
                }));

                if (error instanceof WhatsAppError && error.code === 'TIMEOUT') {
                    break;
                }

                if (attempts < maxRetries) {
                    const message = error instanceof Error ? error.message : String(error);
                    const isNoSessions = message.includes('No sessions');
                    const backoff = isGroup && isNoSessions ? 5000 : 1000;
                    const delay = Math.pow(2, attempts) * backoff;

                    if (this.whatsappService.isVerbose()) {
                        console.log(t('message.sender.retrying', { backoff: delay }));
                    }
                    await this.sleep(delay);
                }
            }
        }

        return {
            success: false,
            error: lastError instanceof Error ? lastError.message : t('message.sender.unknownError'),
            attempts
        };
    }
}
