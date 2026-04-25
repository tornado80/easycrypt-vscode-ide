import { FileSessionKey, UriLike, createFileSessionKey } from './sessionKey';

export type SessionStopReason = 'file-close' | 'manual-stop' | 'config-change' | 'shutdown';

export interface DisposableLike {
    dispose(): void;
}

export interface TextDocumentLike {
    readonly uri: UriLike;
    readonly languageId: string;
}

export interface FileSessionLike extends DisposableLike {
    readonly key: FileSessionKey;
    readonly documentUri: UriLike;
    stop(reason: SessionStopReason): Promise<void>;
}

export interface SessionDisposedEvent {
    readonly key: FileSessionKey;
    readonly reason: SessionStopReason;
}

export interface SessionRegistryOptions<TDocument extends TextDocumentLike, TSession extends FileSessionLike> {
    readonly createSession: (document: TDocument, key: FileSessionKey) => TSession;
    readonly managedLanguageId?: string;
    readonly log?: (
        level: 'debug' | 'info' | 'warn',
        message: string,
        data?: Record<string, unknown>
    ) => void;
}

type SessionListener<T> = (event: T) => void;

class ListenerSet<T> {
    private readonly listeners = new Set<SessionListener<T>>();

    public on(listener: SessionListener<T>): DisposableLike {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            }
        };
    }

    public fire(event: T): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    public clear(): void {
        this.listeners.clear();
    }
}

export class SessionRegistry<
    TDocument extends TextDocumentLike,
    TSession extends FileSessionLike
> implements DisposableLike {
    private readonly sessionsByKey = new Map<FileSessionKey, TSession>();
    private activeKey: FileSessionKey | undefined;
    private disposed = false;

    private readonly createListeners = new ListenerSet<TSession>();
    private readonly disposeListeners = new ListenerSet<SessionDisposedEvent>();
    private readonly activeListeners = new ListenerSet<TSession | undefined>();

    private readonly managedLanguageId: string;

    constructor(private readonly options: SessionRegistryOptions<TDocument, TSession>) {
        this.managedLanguageId = options.managedLanguageId ?? 'easycrypt';
    }

    public onDidCreateSession(listener: SessionListener<TSession>): DisposableLike {
        return this.createListeners.on(listener);
    }

    public onDidDisposeSession(listener: SessionListener<SessionDisposedEvent>): DisposableLike {
        return this.disposeListeners.on(listener);
    }

    public onDidChangeActiveSession(listener: SessionListener<TSession | undefined>): DisposableLike {
        return this.activeListeners.on(listener);
    }

    public getActiveSession(): TSession | undefined {
        if (!this.activeKey) {
            return undefined;
        }

        return this.sessionsByKey.get(this.activeKey);
    }

    public getAllSessions(): readonly TSession[] {
        return Array.from(this.sessionsByKey.values());
    }

    public async getOrCreate(document: TDocument): Promise<TSession> {
        this.throwIfDisposed();

        if (document.languageId !== this.managedLanguageId) {
            throw new Error(`Unsupported language for session registry: ${document.languageId}`);
        }

        const key = await createFileSessionKey(document.uri);
        const existing = this.sessionsByKey.get(key);
        if (existing) {
            return existing;
        }

        const created = this.options.createSession(document, key);
        this.sessionsByKey.set(key, created);

        this.options.log?.('info', 'session-created', {
            sessionKey: key,
            uri: document.uri.toString()
        });
        this.createListeners.fire(created);
        return created;
    }

    public async getByUri(uri: UriLike): Promise<TSession | undefined> {
        const key = await createFileSessionKey(uri);
        return this.sessionsByKey.get(key);
    }

    public async setActiveDocument(document: TDocument | undefined): Promise<TSession | undefined> {
        this.throwIfDisposed();

        if (!document || document.languageId !== this.managedLanguageId) {
            this.setActiveSessionKey(undefined);
            return undefined;
        }

        const session = await this.getOrCreate(document);
        this.setActiveSessionKey(session.key);
        return session;
    }

    public async setActiveUri(uri: UriLike | undefined): Promise<TSession | undefined> {
        this.throwIfDisposed();

        if (!uri) {
            this.setActiveSessionKey(undefined);
            return undefined;
        }

        const key = await createFileSessionKey(uri);
        const session = this.sessionsByKey.get(key);
        this.setActiveSessionKey(session ? key : undefined);
        return session;
    }

    public async disposeSessionByUri(
        uri: UriLike,
        reason: SessionStopReason = 'file-close'
    ): Promise<boolean> {
        const key = await createFileSessionKey(uri);
        return this.disposeSessionByKey(key, reason);
    }

    public async disposeSessionByKey(
        key: FileSessionKey,
        reason: SessionStopReason
    ): Promise<boolean> {
        const session = this.sessionsByKey.get(key);
        if (!session) {
            return false;
        }

        this.sessionsByKey.delete(key);

        if (this.activeKey === key) {
            this.setActiveSessionKey(undefined);
        }

        try {
            await session.stop(reason);
        } catch (error) {
            this.options.log?.('warn', 'session-stop-failed', {
                sessionKey: key,
                reason,
                error: error instanceof Error ? error.message : String(error)
            });
        }

        session.dispose();

        this.options.log?.('info', 'session-disposed', {
            sessionKey: key,
            reason
        });

        this.disposeListeners.fire({ key, reason });
        return true;
    }

    public async disposeAll(reason: SessionStopReason = 'shutdown'): Promise<void> {
        const keys = Array.from(this.sessionsByKey.keys());
        for (const key of keys) {
            await this.disposeSessionByKey(key, reason);
        }
        this.setActiveSessionKey(undefined);
    }

    private setActiveSessionKey(nextKey: FileSessionKey | undefined): void {
        if (this.activeKey === nextKey) {
            return;
        }

        const previousKey = this.activeKey;
        this.activeKey = nextKey;

        this.options.log?.('debug', 'active-session-changed', {
            fromKey: previousKey,
            toKey: nextKey
        });

        this.activeListeners.fire(this.getActiveSession());
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('SessionRegistry has been disposed');
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        void this.disposeAll('shutdown');

        this.createListeners.clear();
        this.disposeListeners.clear();
        this.activeListeners.clear();
    }
}
