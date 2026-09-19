#!/usr/bin/env bun
/**
 * /whatsapp:access — mechanical allowlist + pairing management.
 *
 * Deliberately a plain CLI: every subcommand is deterministic, so the model
 * only has to run it and echo the output instead of reasoning about JSON.
 *
 * Usage: access.ts <status|list|allow|deny|group|ungroup|pair> [arg]
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

type Contact = { number: string; name?: string; sendNumber?: string };
type Config = {
    allowList?: Contact[];
    allowedGroups?: Contact[];
    ignoredNumbers?: Contact[];
    [key: string]: unknown;
};

const root = process.env.WHATSAPP_CHANNEL_HOME || join(homedir(), '.claude', 'channels', 'whatsapp');
const configPath = join(root, 'config.json');
const authDir = join(root, 'auth');
const logPath = join(root, 'whatsapp-channel.log');
const qrPath = join(root, 'qr.txt');

const E164 = /^\+[1-9]\d{6,14}$/;
const isGroup = (jid: string) => jid.endsWith('@g.us');

function die(message: string): never {
    console.error(`error: ${message}`);
    process.exit(1);
}

function readConfig(): Config {
    if (!existsSync(configPath)) return {};
    try {
        return JSON.parse(readFileSync(configPath, 'utf8')) as Config;
    } catch (error) {
        die(`config.json is not valid JSON (${String(error)}) — fix it by hand, refusing to overwrite`);
    }
}

// Whole-object round trip: unknown keys (openaiKey, operatorJid, …) survive.
function writeConfig(config: Config) {
    const temp = `${configPath}.access.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(config, null, 2));
    renameSync(temp, configPath);
}

/** Baileys stores `lid-mapping-<lid>_reverse.json` -> "<phone>". */
function lidIndex(): Map<string, string> {
    const index = new Map<string, string>();
    if (!existsSync(authDir)) return index;
    for (const file of readdirSync(authDir)) {
        const match = file.match(/^lid-mapping-(\d+)_reverse\.json$/);
        if (!match) continue;
        try {
            const phone = JSON.parse(readFileSync(join(authDir, file), 'utf8'));
            if (typeof phone === 'string') index.set(match[1], phone);
        } catch {
            // A damaged mapping file is not worth failing the whole command over.
        }
    }
    return index;
}

function annotate(entry: Contact, lids: Map<string, string>): string {
    const parts = [entry.number];
    if (entry.name) parts.push(entry.name);
    const phone = lids.get(entry.number.replace(/^\+/, ''));
    if (phone) parts.push(`[LID of +${phone}]`);
    return parts.join('  ');
}

function printList(label: string, entries: Contact[] | undefined, lids: Map<string, string>) {
    console.log(`${label}:`);
    if (!entries?.length) {
        console.log('  (empty)');
        return;
    }
    for (const entry of entries) console.log(`  ${annotate(entry, lids)}`);
}

/**
 * Best effort: the channel server is a `bun server.ts` whose cwd is the plugin
 * root. The cmdline alone is not enough — other plugins ship a `server.ts` too,
 * and `bun run --cwd` leaves no path in the child's argv — so match on cwd.
 */
const pluginRoot = join(import.meta.dir, '..', '..');

function serverPids(): string[] {
    let candidates: string[];
    try {
        candidates = execFileSync('pgrep', ['-f', 'server\\.ts'], { encoding: 'utf8' })
            .split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
        return [];
    }
    return candidates.filter(pid => {
        try {
            const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pid], { encoding: 'utf8' });
            return out.split('\n').some(line => line.startsWith('n') && line.slice(1) === pluginRoot);
        } catch {
            return false;
        }
    });
}

/**
 * The server re-reads config.json whenever its mtime changes, so an external
 * edit applies to the next inbound message without a restart.
 */
function reportLiveness() {
    const pids = serverPids();
    console.log(pids.length
        ? `live: server pid ${pids.join(', ')} picks this up on the next inbound message`
        : 'note: channel server not running — start the session with --channels');
}

function mutate(kind: 'allowList' | 'allowedGroups', value: string, add: boolean) {
    const config = readConfig();
    const list = (config[kind] ??= []);
    const existing = list.find(c => c.number === value);

    if (add) {
        if (existing) {
            console.log(`unchanged: ${value} already in ${kind}`);
            return;
        }
        list.push({ number: value });
        // Mirrors SessionManager.addAllowed*: granting access clears the drop record.
        config.ignoredNumbers = (config.ignoredNumbers ?? []).filter(c => c.number !== value);
        console.log(`added: ${value} -> ${kind}`);
    } else {
        if (!existing) {
            console.log(`unchanged: ${value} not in ${kind}`);
            return;
        }
        config[kind] = list.filter(c => c.number !== value);
        console.log(`removed: ${value} <- ${kind}`);
    }

    writeConfig(config);
    reportLiveness();
}

const [subcommand, argument] = process.argv.slice(2);

switch (subcommand) {
    case 'list': {
        const config = readConfig();
        const lids = lidIndex();
        printList('allowList', config.allowList, lids);
        printList('allowedGroups', config.allowedGroups, lids);
        printList('ignoredNumbers', config.ignoredNumbers, lids);
        break;
    }

    case 'status': {
        const config = readConfig();
        const paired = existsSync(join(authDir, 'creds.json'));
        console.log(`storage: ${root}`);
        console.log(`paired: ${paired ? 'yes' : 'no'}`);
        console.log(`status: ${config.status ?? 'unknown'}`);
        console.log(`operator: ${config.operatorJid ?? '(none)'}`);
        const pids = serverPids();
        console.log(`server: ${pids.length ? `running (pid ${pids.join(', ')})` : 'not running — start the session with --channels'}`);
        console.log(`allowList: ${config.allowList?.length ?? 0}, allowedGroups: ${config.allowedGroups?.length ?? 0}, ignoredNumbers: ${config.ignoredNumbers?.length ?? 0}`);
        if (existsSync(qrPath)) console.log('qr.txt: present — run `pair` to render it');
        if (existsSync(logPath)) {
            console.log('log (last 5):');
            const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-5);
            for (const line of lines) console.log(`  ${line}`);
        }
        break;
    }

    case 'allow':
        if (!argument || !E164.test(argument)) die('allow needs a +E.164 number, e.g. +16505551234');
        mutate('allowList', argument, true);
        break;

    case 'deny':
        if (!argument) die('deny needs a number');
        mutate('allowList', argument, false);
        break;

    case 'group':
        if (!argument || !isGroup(argument)) die('group needs a JID ending in @g.us');
        mutate('allowedGroups', argument, true);
        break;

    case 'ungroup':
        if (!argument || !isGroup(argument)) die('ungroup needs a JID ending in @g.us');
        mutate('allowedGroups', argument, false);
        break;

    case 'pair': {
        if (existsSync(join(authDir, 'creds.json'))) {
            const age = statSync(join(authDir, 'creds.json')).mtime.toISOString();
            console.log(`already paired (creds.json from ${age}).`);
            console.log('To re-pair, delete the auth/ directory first, then run `pair` again.');
            break;
        }
        if (!existsSync(qrPath)) die('no qr.txt yet — start the session with --channels and retry once the server connects');
        const payload = readFileSync(qrPath, 'utf8').trim();
        const qrcode = require('qrcode-terminal');
        qrcode.generate(payload, { small: true }, (rendered: string) => {
            console.log(rendered);
            console.log('WhatsApp -> Settings -> Linked devices -> Link a device');
            console.log('This code expires in ~20s. Re-run `pair` for a fresh one.');
        });
        break;
    }

    default:
        console.log('usage: access.ts <status|list|allow <+E164>|deny <+E164>|group <jid@g.us>|ungroup <jid@g.us>|pair>');
        process.exit(subcommand ? 1 : 0);
}
