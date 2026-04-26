export type CommunicationChannel = 'emacs' | 'lsp' | 'auto';

export type ResolvedCommunicationChannel = Exclude<CommunicationChannel, 'auto'>;

export interface ChannelSelectionInput {
    readonly preferredChannel: CommunicationChannel;
    readonly configArgs: readonly string[];
    readonly proverArgs: readonly string[];
}

export interface ChannelSelectionDecision {
    readonly channel: ResolvedCommunicationChannel;
    readonly reason: string;
    readonly hasCompatibilityRisk: boolean;
}

export interface ChannelSelectionPolicy {
    resolvePreferredChannel(input: ChannelSelectionInput): ChannelSelectionDecision;
}

const CONTEXT_SENSITIVE_ARG_PREFIXES = ['-I', '--include', '-R', '--root'];

function hasContextSensitiveArgs(args: readonly string[]): boolean {
    if (args.length === 0) {
        return false;
    }

    return args.some((arg) => {
        const trimmed = arg.trim();
        if (trimmed.length === 0) {
            return false;
        }

        return CONTEXT_SENSITIVE_ARG_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(prefix));
    });
}

function hasCompatibilityRisk(input: ChannelSelectionInput): boolean {
    if (input.proverArgs.length > 0) {
        return true;
    }

    if (input.configArgs.length > 0) {
        return hasContextSensitiveArgs(input.configArgs) || input.configArgs.some((arg) => arg.trim().length > 0);
    }

    return false;
}

export class DefaultChannelSelectionPolicy implements ChannelSelectionPolicy {
    public resolvePreferredChannel(input: ChannelSelectionInput): ChannelSelectionDecision {
        const compatibilityRisk = hasCompatibilityRisk(input);

        switch (input.preferredChannel) {
            case 'emacs':
                return {
                    channel: 'emacs',
                    reason: 'explicit-emacs',
                    hasCompatibilityRisk: compatibilityRisk
                };
            case 'lsp':
                return {
                    channel: 'lsp',
                    reason: 'explicit-lsp',
                    hasCompatibilityRisk: compatibilityRisk
                };
            case 'auto':
            default:
                if (compatibilityRisk) {
                    return {
                        channel: 'emacs',
                        reason: 'auto-context-risk',
                        hasCompatibilityRisk: true
                    };
                }

                return {
                    channel: 'lsp',
                    reason: 'auto-compatible',
                    hasCompatibilityRisk: false
                };
        }
    }
}
