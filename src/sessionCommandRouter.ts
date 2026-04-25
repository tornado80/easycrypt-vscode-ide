import { DisposableLike, FileSessionLike } from './sessionRegistry';

export type RoutedCommandName =
    | 'stepForward'
    | 'stepBackward'
    | 'goToCursor'
    | 'resetProof'
    | 'forceRecovery'
    | 'startProcess'
    | 'stopProcess';

export interface SessionCancellationToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): DisposableLike;
}

class SessionCancellationTokenImpl implements SessionCancellationToken {
    private cancellationRequested = false;
    private readonly listeners = new Set<() => void>();

    public get isCancellationRequested(): boolean {
        return this.cancellationRequested;
    }

    public onCancellationRequested(listener: () => void): DisposableLike {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            }
        };
    }

    public cancel(): void {
        if (this.cancellationRequested) {
            return;
        }

        this.cancellationRequested = true;
        for (const listener of this.listeners) {
            listener();
        }
        this.listeners.clear();
    }

    public dispose(): void {
        this.listeners.clear();
    }
}

interface InFlightCommand {
    readonly requestId: number;
    readonly token: SessionCancellationTokenImpl;
}

export class SessionCommandRouter<TSession extends FileSessionLike> implements DisposableLike {
    private requestCounter = 0;
    private disposed = false;
    private readonly inFlightBySession = new Map<string, InFlightCommand>();

    constructor(
        private readonly getActiveSession: () => TSession | undefined,
        private readonly log?: (
            level: 'debug' | 'info' | 'warn',
            message: string,
            data?: Record<string, unknown>
        ) => void
    ) {}

    public async runOnActiveSession<T>(
        commandName: RoutedCommandName,
        run: (session: TSession, token: SessionCancellationToken) => Promise<T>
    ): Promise<T> {
        this.throwIfDisposed();

        const session = this.getActiveSession();
        if (!session) {
            throw new Error('No active EasyCrypt file');
        }

        const requestId = ++this.requestCounter;
        this.cancelForSession(session.key, `${commandName}:preempted`);

        const token = new SessionCancellationTokenImpl();
        this.inFlightBySession.set(session.key, { requestId, token });

        this.log?.('info', 'session-command-started', {
            command: commandName,
            sessionKey: session.key,
            requestId
        });

        try {
            const result = await run(session, token);

            if (token.isCancellationRequested) {
                throw new Error(`Command cancelled: ${commandName}`);
            }

            const inFlight = this.inFlightBySession.get(session.key);
            if (!inFlight || inFlight.requestId !== requestId) {
                throw new Error(`Stale command completion dropped: ${commandName}`);
            }

            this.log?.('info', 'session-command-completed', {
                command: commandName,
                sessionKey: session.key,
                requestId,
                cancelled: false
            });

            return result;
        } catch (error) {
            this.log?.('warn', 'session-command-failed', {
                command: commandName,
                sessionKey: session.key,
                requestId,
                error: error instanceof Error ? error.message : String(error),
                cancelled: token.isCancellationRequested
            });
            throw error;
        } finally {
            const inFlight = this.inFlightBySession.get(session.key);
            if (inFlight?.requestId === requestId) {
                this.inFlightBySession.delete(session.key);
                inFlight.token.dispose();
            }
        }
    }

    public cancelForSession(sessionKey: string, reason: string): void {
        const inFlight = this.inFlightBySession.get(sessionKey);
        if (!inFlight) {
            return;
        }

        this.log?.('debug', 'session-command-cancelled', {
            sessionKey,
            requestId: inFlight.requestId,
            reason
        });

        this.inFlightBySession.delete(sessionKey);
        inFlight.token.cancel();
        inFlight.token.dispose();
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('SessionCommandRouter has been disposed');
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        for (const [sessionKey, inFlight] of this.inFlightBySession.entries()) {
            this.log?.('debug', 'session-command-cancelled', {
                sessionKey,
                requestId: inFlight.requestId,
                reason: 'router-dispose'
            });
            inFlight.token.cancel();
            inFlight.token.dispose();
        }

        this.inFlightBySession.clear();
    }
}
