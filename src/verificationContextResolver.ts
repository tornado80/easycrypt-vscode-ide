import * as path from 'node:path';

const INCLUDE_FLAG = '-I';

export interface VerificationContext {
    readonly documentPath: string;
    readonly workspaceFolderPath?: string;
    readonly workingDirectory: string;
    readonly includeRoots: readonly string[];
    readonly normalizedUserArgs: readonly string[];
}

export interface SessionContextFingerprint {
    readonly workingDirectory: string;
    readonly includeRoots: readonly string[];
    readonly normalizedUserArgs: readonly string[];
}

export interface ResolveVerificationContextOptions {
    readonly documentPath: string;
    readonly workspaceFolderPath?: string;
    readonly configArgs?: readonly string[];
    readonly proverArgs?: readonly string[];
    readonly fallbackWorkingDirectory?: string;
}

function normalizeForComparison(value: string): string {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function dedupeStablePaths(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];

    for (const value of values) {
        const resolved = path.normalize(path.resolve(value));
        const key = normalizeForComparison(resolved);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(resolved);
    }

    return deduped;
}

function resolveIncludeRoot(includeRoot: string, workingDirectory: string): string {
    if (path.isAbsolute(includeRoot)) {
        return path.normalize(includeRoot);
    }

    return path.normalize(path.resolve(workingDirectory, includeRoot));
}

function extractIncludeRootsFromArgs(args: readonly string[]): string[] {
    const includeRoots: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];

        if (arg === INCLUDE_FLAG && index + 1 < args.length) {
            includeRoots.push(args[index + 1]);
            index += 1;
            continue;
        }

        if (arg.startsWith(INCLUDE_FLAG) && arg.length > INCLUDE_FLAG.length) {
            includeRoots.push(arg.slice(INCLUDE_FLAG.length));
        }
    }

    return includeRoots;
}

export function normalizeCommandArgs(
    configArgs: readonly string[] = [],
    proverArgs: readonly string[] = []
): string[] {
    return [...configArgs, ...proverArgs]
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

export function resolveVerificationContext(options: ResolveVerificationContextOptions): VerificationContext {
    const normalizedDocumentPath = path.normalize(path.resolve(options.documentPath));
    const normalizedWorkspaceFolderPath = options.workspaceFolderPath
        ? path.normalize(path.resolve(options.workspaceFolderPath))
        : undefined;
    const fallbackWorkingDirectory = options.fallbackWorkingDirectory
        ? path.normalize(path.resolve(options.fallbackWorkingDirectory))
        : path.normalize(process.cwd());

    const documentDirectory = path.dirname(normalizedDocumentPath);
    const workingDirectory = documentDirectory || normalizedWorkspaceFolderPath || fallbackWorkingDirectory;
    const normalizedUserArgs = normalizeCommandArgs(options.configArgs, options.proverArgs);

    const explicitIncludeRoots = extractIncludeRootsFromArgs(normalizedUserArgs)
        .map((includeRoot) => resolveIncludeRoot(includeRoot, workingDirectory));
    const explicitIncludeKeys = new Set(explicitIncludeRoots.map((includeRoot) => normalizeForComparison(includeRoot)));

    const preferredIncludeRoots = dedupeStablePaths(
        [documentDirectory, normalizedWorkspaceFolderPath].filter(
            (candidate): candidate is string => Boolean(candidate && candidate.length > 0)
        )
    );

    const includeRoots = preferredIncludeRoots.filter(
        (includeRoot) => !explicitIncludeKeys.has(normalizeForComparison(includeRoot))
    );

    return {
        documentPath: normalizedDocumentPath,
        workspaceFolderPath: normalizedWorkspaceFolderPath,
        workingDirectory: path.normalize(workingDirectory),
        includeRoots,
        normalizedUserArgs
    };
}

function appendIncludeRoots(args: string[], includeRoots: readonly string[]): void {
    for (const includeRoot of includeRoots) {
        args.push(INCLUDE_FLAG, includeRoot);
    }
}

export function buildCompileArgs(context: VerificationContext, targetFilePath: string): string[] {
    const args: string[] = ['compile', '-script', ...context.normalizedUserArgs];
    appendIncludeRoots(args, context.includeRoots);
    args.push(targetFilePath);
    return args;
}

export function buildCliArgs(context: SessionContextFingerprint): string[] {
    const args: string[] = ['cli', '-emacs', ...context.normalizedUserArgs];
    appendIncludeRoots(args, context.includeRoots);
    return args;
}

export function fingerprintVerificationContext(context: VerificationContext): SessionContextFingerprint {
    return {
        workingDirectory: context.workingDirectory,
        includeRoots: [...context.includeRoots],
        normalizedUserArgs: [...context.normalizedUserArgs]
    };
}

export function cloneSessionContextFingerprint(context: SessionContextFingerprint): SessionContextFingerprint {
    return {
        workingDirectory: context.workingDirectory,
        includeRoots: [...context.includeRoots],
        normalizedUserArgs: [...context.normalizedUserArgs]
    };
}

export function sessionContextEquals(
    left: SessionContextFingerprint | undefined,
    right: SessionContextFingerprint | undefined
): boolean {
    if (!left || !right) {
        return left === right;
    }

    if (normalizeForComparison(left.workingDirectory) !== normalizeForComparison(right.workingDirectory)) {
        return false;
    }

    if (left.includeRoots.length !== right.includeRoots.length) {
        return false;
    }

    if (left.normalizedUserArgs.length !== right.normalizedUserArgs.length) {
        return false;
    }

    for (let index = 0; index < left.includeRoots.length; index++) {
        if (normalizeForComparison(left.includeRoots[index]) !== normalizeForComparison(right.includeRoots[index])) {
            return false;
        }
    }

    for (let index = 0; index < left.normalizedUserArgs.length; index++) {
        if (left.normalizedUserArgs[index] !== right.normalizedUserArgs[index]) {
            return false;
        }
    }

    return true;
}
