/**
 * Port of the Expensify/App `useOnyx` wrapper (`src/hooks/useOnyx.ts`), which every App component calls
 * instead of the library hook: on a search screen a snapshot-compatible key is read out of the search
 * snapshot. The hook calls, context reads and selector wrapping match the App's, so a hook scenario pays
 * the same wrapper overhead the App pays.
 */
import type {OnyxKey, UseOnyxOptions, UseOnyxResult} from 'react-native-onyx';

import {useOnyx as useOnyxWithoutSnapshots} from 'react-native-onyx';

import {use} from 'react';

import CONST from './CONST';
import ONYXKEYS from './ONYXKEYS';
import {SearchQueryContext, SearchResultsContext, useIsOnSearch} from './search';

type UseOnyxWithoutSnapshots = typeof useOnyxWithoutSnapshots;

const COLLECTION_VALUES: readonly string[] = Object.values(ONYXKEYS.COLLECTION);

const SNAPSHOT_ONYX_KEYS: readonly string[] = CONST.SEARCH.SNAPSHOT_ONYX_KEYS;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getSnapshotData(snapshot: unknown): Record<string, unknown> | undefined {
    if (!isRecord(snapshot) || !isRecord(snapshot.data)) {
        return undefined;
    }

    return snapshot.data;
}

function getDataByPath(data: Record<string, unknown> | undefined, path: string): unknown {
    for (const collection of COLLECTION_VALUES) {
        if (path.startsWith(collection)) {
            const key = `${collection}${path.slice(collection.length)}`;
            return data?.[key];
        }
    }

    return data?.[path];
}

function getKeyData(snapshot: unknown, key: OnyxKey): unknown {
    const data = getSnapshotData(snapshot);

    if (key.endsWith('_')) {
        const result: Record<string, unknown> = {};

        for (const [dataKey, value] of Object.entries(data ?? {})) {
            if (!dataKey.startsWith(key)) {
                continue;
            }
            result[dataKey] = value;
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }

    return getDataByPath(data, key);
}

function resolveSnapshotAwareResult(shouldUseSnapshot: boolean, hasSelector: boolean, originalResult: UseOnyxResult<unknown>, key: OnyxKey): UseOnyxResult<unknown> {
    if (!shouldUseSnapshot || hasSelector) {
        return originalResult;
    }

    const keyData = getKeyData(originalResult[0], key);

    return [keyData === null || keyData === undefined ? undefined : keyData, originalResult[1]];
}

function useOnyxWithSnapshots(key: OnyxKey, options?: UseOnyxOptions<OnyxKey, unknown>): UseOnyxResult<unknown> {
    const isSnapshotCompatibleKey = !key.startsWith(ONYXKEYS.COLLECTION.SNAPSHOT) && SNAPSHOT_ONYX_KEYS.some((snapshotKey) => key.startsWith(snapshotKey));
    const isOnSearch = useIsOnSearch();

    let currentSearchHash: number | undefined;
    let shouldUseLiveData = false;
    if (isOnSearch && isSnapshotCompatibleKey) {
        const {currentSearchHash: searchContextCurrentSearchHash} = use(SearchQueryContext);
        const {shouldUseLiveData: contextShouldUseLiveData} = use(SearchResultsContext);
        currentSearchHash = searchContextCurrentSearchHash;
        shouldUseLiveData = !!contextShouldUseLiveData;
    }

    const {selector: selectorProp, ...optionsWithoutSelector} = options ?? {};

    const shouldUseSnapshot = isOnSearch && !!currentSearchHash && isSnapshotCompatibleKey && !shouldUseLiveData;

    const selector = !selectorProp || !shouldUseSnapshot ? selectorProp : (data: unknown) => selectorProp(getKeyData(data, key));

    const onyxOptions: UseOnyxOptions<OnyxKey, unknown> = {...optionsWithoutSelector, selector};
    const snapshotKey: OnyxKey = shouldUseSnapshot ? `${ONYXKEYS.COLLECTION.SNAPSHOT}${currentSearchHash}` : key;

    const originalResult = useOnyxWithoutSnapshots(snapshotKey, onyxOptions);

    return resolveSnapshotAwareResult(shouldUseSnapshot, !!selector, originalResult, key);
}

// The one cast of the port, as in the App: the wrapper cannot prove a key's value type from a snapshot read,
// so it takes the library hook's generic signature on trust.
const useOnyx = useOnyxWithSnapshots as UseOnyxWithoutSnapshots;

export default useOnyx;
