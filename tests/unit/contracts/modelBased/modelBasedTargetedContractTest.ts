import {ONYX_KEYS} from '../update/harness';
import {OBSERVED_TARGETS, bootOnyx, markTarget, observe, readCache, readThroughConnections, runAwaited, unmountAll} from './harness';
import {SKIPPABLE_MEMBER} from './model';

const {NEST, NEST_LEVEL} = ONYX_KEYS.COLLECTION;

describe('Onyx write API as one system, cases the random sequences rarely reach', () => {
    it('keeps every subscriber silent when multiSet restates a primitive it already delivered', async () => {
        const onyx = await bootOnyx({});
        const observers = await observe(onyx);
        await runAwaited(onyx, {kind: 'multiSet', data: {[ONYX_KEYS.OTHER_KEY]: 7}});
        const marks = OBSERVED_TARGETS.map((target) => ({target, received: markTarget(observers, target)}));

        await runAwaited(onyx, {kind: 'multiSet', data: {[ONYX_KEYS.OTHER_KEY]: 7}});

        for (const {target, received} of marks) {
            expect({target, received: received()}).toEqual({target, received: {connect: [], hook: []}});
        }
        unmountAll(observers);
    });

    it('keeps every subscriber silent when multiSet removes keys that hold nothing', async () => {
        const onyx = await bootOnyx({[`${NEST}1`]: {a: 1}, [`${NEST_LEVEL}1`]: {b: 1}});
        const observers = await observe(onyx);
        const marks = OBSERVED_TARGETS.map((target) => ({target, received: markTarget(observers, target)}));

        await runAwaited(onyx, {kind: 'multiSet', data: {[ONYX_KEYS.TEST_KEY]: null, [`${NEST}2`]: null, [`${NEST_LEVEL}2`]: null}});

        for (const {target, received} of marks) {
            expect({target, received: received()}).toEqual({target, received: {connect: [], hook: []}});
        }
        unmountAll(observers);
    });

    it('leaves skippable members found in storage out of the hydrated state', async () => {
        const onyx = await bootOnyx({[`${NEST}1`]: {a: 1}, [SKIPPABLE_MEMBER]: {b: 1}});

        expect(readCache(onyx)[SKIPPABLE_MEMBER]).toBeUndefined();
        const views = await readThroughConnections(onyx);
        expect(views[SKIPPABLE_MEMBER]).toBeUndefined();
        expect(views[NEST]).toEqual({[`${NEST}1`]: {a: 1}});
    });
});
