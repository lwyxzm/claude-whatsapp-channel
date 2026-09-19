/**
 * Keep stdout clean for the MCP protocol stream.
 *
 * Claude Code speaks JSON-RPC to this server over stdio. Anything else written
 * to fd 1 corrupts a frame and kills the connection. The reused whatsapp-pi
 * services log connection state through console.log (whatsapp.service.ts,
 * message.sender.ts, WhatsAppPiLogger.info), and Baileys writes its own
 * warnings, so redirect every stdout-bound console method to stderr instead of
 * auditing each call site.
 *
 * Import this module FIRST — ESM runs import side effects in order, so the
 * patch lands before Baileys or any service module is evaluated.
 *
 * Note: pino bypasses console and writes to fd 1 directly, so it is never given
 * a level above 'silent'. See docs in server.ts (setVerboseMode stays off).
 */

const format = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const toStderr = (...args: unknown[]): void => {
    try {
        process.stderr.write(args.map(format).join(' ') + '\n');
    } catch {
        // Logging is best-effort; never let it throw into a message handler.
    }
};

console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
// console.error already writes to stderr.

export {};
