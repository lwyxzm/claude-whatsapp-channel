import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const MAX_OUTGOING_IMAGE_BYTES = 16 * 1024 * 1024;

export interface OutgoingImage {
    absolutePath: string;
    data: Buffer;
    mimetype: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

function detectImageMimeType(data: Buffer): OutgoingImage['mimetype'] | undefined {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg';
    }
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) {
        return 'image/gif';
    }
    if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    return undefined;
}

export async function loadOutgoingImage(path: string, cwd: string): Promise<OutgoingImage> {
    const normalizedPath = path.trim().replace(/^@/, '');
    if (!normalizedPath) {
        throw new Error('Image path is required');
    }

    const absolutePath = resolve(cwd, normalizedPath);
    const imageStat = await stat(absolutePath);
    if (!imageStat.isFile()) {
        throw new Error(`Image path is not a file: ${absolutePath}`);
    }
    if (imageStat.size === 0) {
        throw new Error('Image file is empty');
    }
    if (imageStat.size > MAX_OUTGOING_IMAGE_BYTES) {
        throw new Error(`Image exceeds the 16 MB limit (${imageStat.size} bytes)`);
    }

    const data = await readFile(absolutePath);
    const mimetype = detectImageMimeType(data);
    if (!mimetype) {
        throw new Error('Unsupported image format. Use JPEG, PNG, GIF, or WebP.');
    }

    return { absolutePath, data, mimetype };
}
