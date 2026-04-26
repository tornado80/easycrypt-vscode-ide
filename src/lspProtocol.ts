export interface LspProofResponse {
    readonly output: string;
    readonly processedEnd: number;
    readonly sentenceStart: number | null;
    readonly sentenceEnd: number | null;
    readonly uuid: number;
    readonly mode: string;
}

export interface LspQueryResponse {
    readonly output: string;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        throw new Error(`Invalid LSP ${label} response: expected object`);
    }

    return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`Invalid LSP response: field ${field} is not a string`);
    }

    return value;
}

function expectNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid LSP response: field ${field} is not a number`);
    }

    return value;
}

function expectNullableNumber(value: unknown, field: string): number | null {
    if (value === null || value === undefined) {
        return null;
    }

    return expectNumber(value, field);
}

export function parseLspProofResponse(value: unknown): LspProofResponse {
    const response = expectObject(value, 'proof');
    return {
        output: expectString(response.output, 'output'),
        processedEnd: expectNumber(response.processedEnd, 'processedEnd'),
        sentenceStart: expectNullableNumber(response.sentenceStart, 'sentenceStart'),
        sentenceEnd: expectNullableNumber(response.sentenceEnd, 'sentenceEnd'),
        uuid: expectNumber(response.uuid, 'uuid'),
        mode: expectString(response.mode, 'mode')
    };
}

export function parseLspQueryResponse(value: unknown): LspQueryResponse {
    const response = expectObject(value, 'query');
    return {
        output: expectString(response.output, 'output')
    };
}
