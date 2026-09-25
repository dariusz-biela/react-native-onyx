import {DEFAULT_VALUE, ONYX_KEYS} from '../update/harness';
import {bootOnyx, findHook, markTarget, observe, readCache, readStorage, readThroughConnections, runAwaited, runTogether, unmountAll} from './harness';

const {NEST, NEST_LEVEL} = ONYX_KEYS.COLLECTION;

describe('Onyx write API as one system', () => {
    describe('current behaviour (suspected bug)', () => {
        it('removes prefix-colliding child members on a parent setCollection without notifying their collection subscribers', async () => {
            const onyx = await bootOnyx({[`${NEST}1`]: {a: 1}, [`${NEST_LEVEL}1`]: {b: 1}});
            const observers = await observe(onyx);
            const childCollection = markTarget(observers, NEST_LEVEL);

            await runAwaited(onyx, {kind: 'setCollection', collectionKey: NEST, data: {[`${NEST}1`]: {a: 1}}});

            expect(readCache(onyx)[`${NEST_LEVEL}1`]).toBeUndefined();
            expect(readStorage(onyx)[`${NEST_LEVEL}1`]).toBeUndefined();
            // The member and its collection are gone from the store, yet the collection observers still show them.
            expect(childCollection()).toStrictEqual({connect: [], hook: []});
            expect(findHook(observers, NEST_LEVEL).renders.at(-1)?.value).toEqual({[`${NEST_LEVEL}1`]: {b: 1}});
            unmountAll(observers);
        });

        it('re-notifies member connections and hooks when mergeCollection restates an array property', async () => {
            const onyx = await bootOnyx({[`${NEST}1`]: {name: [1, 2], a: 1}});
            const observers = await observe(onyx);
            const member = markTarget(observers, `${NEST}1`);

            await runAwaited(onyx, {kind: 'mergeCollection', collectionKey: NEST, data: {[`${NEST}1`]: {name: [1, 2]}}});

            // merge() of the same change notifies nobody.
            expect(member()).toEqual({connect: [{name: [1, 2], a: 1}], hook: [{name: [1, 2], a: 1}]});
            unmountAll(observers);
        });

        it('re-notifies a member connection when mergeCollection restates an empty array member', async () => {
            const onyx = await bootOnyx({[`${NEST}1`]: []});
            const observers = await observe(onyx);
            const member = markTarget(observers, `${NEST}1`);

            await runAwaited(onyx, {kind: 'mergeCollection', collectionKey: NEST, data: {[`${NEST}1`]: []}});

            expect(member().connect).toEqual([[]]);
            unmountAll(observers);
        });
    });

    // Fixed by #834: main applied the later call first, as noted per test.
    describe('writes issued in the same tick apply in call order', () => {
        it('applies an update that sets a member after an Onyx.merge of it issued earlier in the same tick', async () => {
            const onyx = await bootOnyx({});

            await runTogether(onyx, [
                {kind: 'merge', key: `${NEST}1`, value: {x: 1}},
                {
                    kind: 'update',
                    updates: [
                        {onyxMethod: 'set', key: `${NEST}1`, value: {c: 2}},
                        {onyxMethod: 'merge', key: `${NEST}2`, value: {y: 1}},
                    ],
                },
            ]);

            // main ended in {c: 2, x: 1}.
            expect(readCache(onyx)[`${NEST}1`]).toEqual({c: 2});
            expect(readStorage(onyx)[`${NEST}1`]).toEqual({c: 2});
        });

        it('applies a mergeCollection removal of a member that an Onyx.merge created earlier in the same tick', async () => {
            const onyx = await bootOnyx({});

            await runTogether(onyx, [
                {kind: 'merge', key: `${NEST}1`, value: {x: 1}},
                {kind: 'mergeCollection', collectionKey: NEST, data: {[`${NEST}1`]: null, [`${NEST}2`]: {y: 1}}},
            ]);

            // main kept nest_1 as {x: 1}.
            expect(readCache(onyx)[`${NEST}1`]).toBeUndefined();
            expect(readStorage(onyx)[`${NEST}1`]).toBeUndefined();
            expect(readCache(onyx)[`${NEST}2`]).toEqual({y: 1});
            expect(readStorage(onyx)[`${NEST}2`]).toEqual({y: 1});
        });

        it('rejects a mergeCollection array over an object that an Onyx.merge created earlier in the same tick', async () => {
            const onyx = await bootOnyx({});

            await runTogether(onyx, [
                {kind: 'merge', key: `${NEST}1`, value: {count: 1}},
                {kind: 'mergeCollection', collectionKey: NEST, data: {[`${NEST}1`]: []}},
            ]);

            // main let the array replace the object.
            expect(readCache(onyx)[`${NEST}1`]).toEqual({count: 1});
            expect(readStorage(onyx)[`${NEST}1`]).toEqual({count: 1});
        });
    });

    describe('current behaviour (#834 change)', () => {
        it('tells a prefix-colliding child member subscriber it is gone when a parent setCollection removes it', async () => {
            const onyx = await bootOnyx({[`${NEST}1`]: {a: 1}, [`${NEST_LEVEL}1`]: {b: 1}});
            const observers = await observe(onyx);
            const member = markTarget(observers, `${NEST_LEVEL}1`);

            await runAwaited(onyx, {kind: 'setCollection', collectionKey: NEST, data: {[`${NEST}1`]: {a: 1}}});

            // main left the member connection and hook silent on {b: 1}.
            expect(member()).toStrictEqual({connect: [undefined], hook: [undefined]});
            expect(findHook(observers, `${NEST_LEVEL}1`).renders.at(-1)?.value).toBeUndefined();
            unmountAll(observers);
        });
    });

    describe('clear across prefix-colliding collections', () => {
        it('notifies both collections and every member once, and a re-init keeps only the defaults', async () => {
            const onyx = await bootOnyx({[`${NEST}1`]: {a: 1}, [`${NEST_LEVEL}1`]: {b: 1}, [ONYX_KEYS.TEST_KEY]: {c: 1}});
            const observers = await observe(onyx);
            const targets = [NEST, NEST_LEVEL, `${NEST}1`, `${NEST_LEVEL}1`, ONYX_KEYS.TEST_KEY];
            const marks = targets.map((target) => markTarget(observers, target));

            await runAwaited(onyx, {kind: 'clear'});

            const received = marks.map((mark) => mark());
            for (const [index, target] of targets.entries()) {
                const expected = target === NEST || target === NEST_LEVEL ? {} : undefined;
                expect({target, connect: received[index].connect.length, last: received[index].connect.at(-1) ?? undefined}).toEqual({target, connect: 1, last: expected});
                expect({target, hookLast: received[index].hook.at(-1) ?? undefined}).toEqual({target, hookLast: expected});
            }
            unmountAll(observers);

            const reborn = await bootOnyx(readStorage(onyx));
            expect(readCache(reborn)).toEqual({[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
            expect(await readThroughConnections(reborn)).toMatchObject({[NEST]: {}, [NEST_LEVEL]: {}, [`${NEST}1`]: undefined, [ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
        });
    });

    describe('contrast with merge', () => {
        it('keeps every subscriber silent when merge restates an array property', async () => {
            const onyx = await bootOnyx({[`${NEST}1`]: {name: [1, 2], a: 1}});
            const observers = await observe(onyx);
            const member = markTarget(observers, `${NEST}1`);
            const collection = markTarget(observers, NEST);

            await runAwaited(onyx, {kind: 'merge', key: `${NEST}1`, value: {name: [1, 2]}});

            expect(member()).toStrictEqual({connect: [], hook: []});
            expect(collection()).toStrictEqual({connect: [], hook: []});
            unmountAll(observers);
        });
    });
});
