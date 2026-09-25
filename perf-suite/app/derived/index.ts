/**
 * Port of the Expensify/App derived-value engine (`src/libs/actions/OnyxDerived/index.ts`) with every Onyx-facing
 * step kept: the one-shot read of the stored value, one `connectWithoutView` per dependency, the locale dependency
 * gated on the translations flag, no write until every connection has fired, per-dependency callbacks coalesced into
 * one compute on a microtask, collection deltas rebuilt by reference, the reset on `Onyx.clear`, and the write back
 * with `skipCacheCheck`. Logging, telemetry spans and the loop detector are App-side and left out. The dependency
 * lists come from the App (`generated/DERIVED_DEPENDENCIES.ts`); the compute is `computeSyntheticValue`.
 */
import type {OnyxKey} from 'react-native-onyx';

import Onyx from 'react-native-onyx';
import OnyxCache, {TASK} from 'react-native-onyx/dist/OnyxCache';

import type {SyntheticValue} from './computeSyntheticValue';
import type {CollectionSnapshot} from './getCollectionDelta';

import DERIVED_DEPENDENCIES from '../generated/DERIVED_DEPENDENCIES';
import ONYXKEYS from '../ONYXKEYS';
import computeSyntheticValue, {isRecord, toSyntheticValue} from './computeSyntheticValue';
import getCollectionDelta from './getCollectionDelta';

type DerivedConfig = (typeof DERIVED_DEPENDENCIES)[number];

/** The App always loads a locale before clearing the translations flag; the suite runs in English. */
const LOCALE = 'en';

const COLLECTION_KEYS: ReadonlySet<string> = new Set(Object.values(ONYXKEYS.COLLECTION));

function isCollectionKey(key: string): boolean {
    return COLLECTION_KEYS.has(key);
}

function toCollectionSnapshot(value: unknown): CollectionSnapshot {
    return isRecord(value) ? value : undefined;
}

function readStoredValue(key: OnyxKey): Promise<unknown> {
    return new Promise((resolve) => {
        const connection = Onyx.connectWithoutView({
            key,
            callback: (storedValue) => {
                Onyx.disconnect(connection);
                resolve(storedValue);
            },
        });
    });
}

function initDerivedValue({key, dependencies}: DerivedConfig): void {
    const totalConnections = dependencies.length;
    const dependencyValues = new Array<unknown>(totalConnections);
    const connectionInitializedFlags = new Array<boolean>(totalConnections).fill(false);
    const collectionSourceIndex = dependencies.findIndex((dependency) => isCollectionKey(dependency));
    const sourceIndex = Math.max(collectionSourceIndex, 0);

    readStoredValue(key).then((storedValue) => {
        let derivedValue: SyntheticValue | undefined = toSyntheticValue(storedValue);
        let areAllConnectionsSet = false;
        let connectionsEstablishedCount = 0;
        let flushScheduled = false;
        let hasFlushedOnce = false;
        let clearHandled = false;
        const pendingDependencyIndexes = new Set<number>();
        const lastFlushedCollectionValues = new Array<CollectionSnapshot>(totalConnections);

        const checkAndMarkConnectionInitialized = (index: number) => {
            if (connectionInitializedFlags[index]) {
                return;
            }

            connectionInitializedFlags[index] = true;
            connectionsEstablishedCount++;
            areAllConnectionsSet = connectionsEstablishedCount === totalConnections;
        };

        const resetForClear = () => {
            derivedValue = undefined;
            hasFlushedOnce = false;
            lastFlushedCollectionValues.length = 0;
        };

        const flushRecompute = () => {
            flushScheduled = false;

            let sourceDelta: CollectionSnapshot;
            const stagedBaselines: Array<[number, CollectionSnapshot]> = [];

            if (hasFlushedOnce) {
                for (const index of pendingDependencyIndexes) {
                    if (!isCollectionKey(dependencies[index])) {
                        continue;
                    }

                    const currentValue = toCollectionSnapshot(dependencyValues[index]);
                    const delta = getCollectionDelta(currentValue, lastFlushedCollectionValues[index]);
                    stagedBaselines.push([index, currentValue]);

                    if (index === collectionSourceIndex) {
                        sourceDelta = delta;
                    }
                }
            } else {
                for (let index = 0; index < totalConnections; index++) {
                    if (isCollectionKey(dependencies[index])) {
                        stagedBaselines.push([index, toCollectionSnapshot(dependencyValues[index])]);
                    }
                }
            }

            derivedValue = computeSyntheticValue(dependencyValues[sourceIndex], hasFlushedOnce ? derivedValue : undefined, sourceDelta, collectionSourceIndex >= 0);
            Onyx.set(key, derivedValue, {skipCacheCheck: true});

            for (const [index, value] of stagedBaselines) {
                lastFlushedCollectionValues[index] = value;
            }
            hasFlushedOnce = true;
            pendingDependencyIndexes.clear();
        };

        const recomputeDerivedValue = (triggeredByIndex: number) => {
            if (!areAllConnectionsSet) {
                checkAndMarkConnectionInitialized(triggeredByIndex);
            }

            if (!areAllConnectionsSet) {
                return;
            }

            if (OnyxCache.hasPendingTask(TASK.CLEAR)) {
                if (!clearHandled) {
                    clearHandled = true;
                    resetForClear();
                }
            } else {
                clearHandled = false;
            }

            pendingDependencyIndexes.add(triggeredByIndex);
            if (flushScheduled) {
                return;
            }
            flushScheduled = true;
            queueMicrotask(flushRecompute);
        };

        dependencies.forEach((dependency, dependencyIndex) => {
            if (dependency === ONYXKEYS.NVP_PREFERRED_LOCALE) {
                Onyx.connectWithoutView({
                    key: ONYXKEYS.RAM_ONLY_ARE_TRANSLATIONS_LOADING,
                    callback: (areTranslationsLoading) => {
                        if (areTranslationsLoading ?? true) {
                            return;
                        }
                        dependencyValues[dependencyIndex] = LOCALE;
                        recomputeDerivedValue(dependencyIndex);
                    },
                });
                return;
            }

            Onyx.connectWithoutView({
                key: dependency,
                callback: (value) => {
                    dependencyValues[dependencyIndex] = value;
                    recomputeDerivedValue(dependencyIndex);
                },
            });
        });
    });
}

/** Wires every derived value the App defines, like the App's `initOnyxDerivedValues()` at startup. */
function initOnyxDerivedValues(): void {
    for (const config of DERIVED_DEPENDENCIES) {
        initDerivedValue(config);
    }
}

export default initOnyxDerivedValues;
