import * as path from 'node:path';
import { realpath } from 'node:fs/promises';

export type FileSessionKey = string;

export interface UriLike {
    readonly scheme: string;
    readonly fsPath?: string;
    toString(): string;
}

function normalizeForPlatform(value: string, platform: NodeJS.Platform): string {
    const normalized = path.normalize(path.resolve(value));
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function normalizeFileSystemPathForSessionKey(
    fsPath: string,
    platform: NodeJS.Platform = process.platform
): string {
    return normalizeForPlatform(fsPath, platform);
}

export async function canonicalizeFileSystemPathForSessionKey(fsPath: string): Promise<string> {
    try {
        const resolved = await realpath(fsPath);
        return normalizeFileSystemPathForSessionKey(resolved);
    } catch {
        return normalizeFileSystemPathForSessionKey(fsPath);
    }
}

export async function createFileSessionKey(uri: UriLike): Promise<FileSessionKey> {
    if (uri.scheme !== 'file' || !uri.fsPath) {
        return uri.toString();
    }

    const canonicalPath = await canonicalizeFileSystemPathForSessionKey(uri.fsPath);
    return `file:${canonicalPath}`;
}
