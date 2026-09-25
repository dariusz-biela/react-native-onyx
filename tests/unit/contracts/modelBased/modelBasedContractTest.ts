import type {State} from '../update/harness';
import type {FreshOnyx} from './harness';
import type {Op} from './model';

import {isPlainObject} from '../update/harness';
import {checkStep, expectStoreMatches, startTracking} from './checker';
import {createRandom, randomOp, randomStoredState} from './generator';
import {OBSERVED_TARGETS, bootOnyx, normalize, observe, readCache, readStorage, readThroughConnections, runAwaited, unmountAll} from './harness';
import {applyOp, hydratedState, initialModel, project} from './model';

const SEQUENCE_SEEDS = Array.from({length: 150}, (_, index) => 1000 + index);
const STEPS_PER_SEQUENCE = 14;
function containsArray(value: unknown): boolean {
    if (Array.isArray(value)) {
        return true;
    }
    return isPlainObject(value) && Object.values(value).some(containsArray);
}

/**
 * Replacing writes (multiSet, setCollection and the grouped sets of update) re-notify deep-equal values, and a null
 * merged into a missing key re-delivers undefined; both are pinned in the multiSet, connect and merge contracts.
 * mergeCollection re-notifies members whose restated value holds an array (pinned as a suspected bug). Those writes
 * only have to deliver the unchanged value.
 */
function isSilentWhenUnchanged(op: Op): boolean {
    switch (op.kind) {
        case 'multiSet':
        case 'setCollection':
            return false;
        case 'merge':
            return op.value !== null;
        case 'mergeCollection':
            return !containsArray(op.data);
        case 'update':
            return op.updates.every((entry) => (entry.onyxMethod === 'mergecollection' || entry.onyxMethod === 'merge') && entry.value !== null && !containsArray(entry.value));
        default:
            return true;
    }
}

async function expectReinitMatches(label: string, onyx: FreshOnyx, model: State): Promise<void> {
    const reborn = await bootOnyx(readStorage(onyx));
    const expected = hydratedState(model);
    expect({label, cache: readCache(reborn)}).toEqual({label, cache: expected});

    const views = await readThroughConnections(reborn);
    const expectedViews = Object.fromEntries(OBSERVED_TARGETS.map((target) => [target, normalize(target, project(expected, target))]));
    expect({label, views}).toEqual({label, views: expectedViews});

    const observers = await observe(reborn);
    startTracking(`${label} hooks`, observers, expected);
    unmountAll(observers);
}

describe('Onyx write API as one system, checked against a reference model', () => {
    it.each(SEQUENCE_SEEDS)('seed %i: cache, storage, subscribers and hooks follow every awaited step, and a re-init restores the state', async (seed) => {
        const random = createRandom(seed);
        const stored = randomStoredState(random);
        const onyx = await bootOnyx(stored);
        let model = initialModel(stored);
        expectStoreMatches(`seed ${seed} boot`, onyx, model);

        const observers = await observe(onyx);
        const tracker = startTracking(`seed ${seed} boot`, observers, model);

        for (let step = 0; step < STEPS_PER_SEQUENCE; step++) {
            const op = randomOp(random, model);
            await runAwaited(onyx, op);
            const after = applyOp(model, op);
            checkStep({label: `seed ${seed} step ${step}`, op, before: model, after, isSilentWhenUnchanged}, onyx, observers, tracker);
            model = after;
        }

        unmountAll(observers);
        await expectReinitMatches(`seed ${seed} re-init`, onyx, model);
    });
});
