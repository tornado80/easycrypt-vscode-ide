export interface DecorationProjectionStateModel<TRange> {
    readonly verifiedRange?: TRange;
    readonly processingRange?: TRange;
    readonly verifyingRange?: TRange;
}

export function computeProjectedStates<TRange>(
    activeKey: string | undefined,
    visibleEditorKeys: readonly string[],
    stateByKey: ReadonlyMap<string, DecorationProjectionStateModel<TRange>>
): Map<string, DecorationProjectionStateModel<TRange> | undefined> {
    const projected = new Map<string, DecorationProjectionStateModel<TRange> | undefined>();

    for (const key of visibleEditorKeys) {
        if (!activeKey || key !== activeKey) {
            projected.set(key, undefined);
            continue;
        }

        projected.set(key, stateByKey.get(key));
    }

    return projected;
}
