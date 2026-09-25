import type {State} from '../update/harness';

import {checkBatch, startTracking} from './checker';
import {createRandom, randomBatch, randomStoredState} from './generator';
import {bootOnyx, observe, readCache, readStorage, runTogether, unmountAll} from './harness';
import {applyOp, hydratedState, initialModel} from './model';

const BATCH_SEEDS = Array.from({length: 100}, (_, index) => 5000 + index);
const BATCHES_PER_SEQUENCE = 5;

describe('Onyx write API with writes issued together, checked against a reference model', () => {
    it.each(BATCH_SEEDS)('seed %i: un-awaited writes settle to the sequential result in the store, the subscribers and the hooks', async (seed) => {
        const random = createRandom(seed);
        const stored = randomStoredState(random);
        const onyx = await bootOnyx(stored);
        let model = initialModel(stored);
        const observers = await observe(onyx);
        const tracker = startTracking(`seed ${seed} boot`, observers, model);

        for (let batch = 0; batch < BATCHES_PER_SEQUENCE; batch++) {
            const ops = randomBatch(random, model);
            const states: State[] = [model];
            for (const op of ops) {
                states.push(applyOp(states[states.length - 1], op));
            }
            await runTogether(onyx, ops);
            checkBatch({label: `seed ${seed} batch ${batch}`, ops, states}, onyx, observers, tracker);
            model = states[states.length - 1];
        }

        unmountAll(observers);
        const reborn = await bootOnyx(readStorage(onyx));
        expect({seed, cache: readCache(reborn)}).toEqual({seed, cache: hydratedState(model)});
    });
});
