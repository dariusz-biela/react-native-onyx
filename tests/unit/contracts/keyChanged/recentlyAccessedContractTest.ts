import type {OnyxKey} from '../../../../lib/types';
import {KEYS} from '../connect/utils/freshOnyx';
import {R1, R2, R3, REPORT, startHarness} from './utils/harness';

const EVICTABLE = {evictableKeys: [REPORT]};

describe('recently accessed keys maintained by notifyKey and notifyCollection', () => {
    it('moves a member to the most recent end each time a write notifies it', async () => {
        const {Onyx, cache} = await startHarness(EVICTABLE);

        await Onyx.set(R1, {v: 1});
        await Onyx.set(R2, {v: 2});
        expect(cache.getKeyForEviction()).toBe(R1);

        await Onyx.set(R1, {v: 11});
        expect(cache.getKeyForEviction()).toBe(R2);
    });

    it('moves the members of a collection batch to the most recent end', async () => {
        const {Onyx, cache} = await startHarness(EVICTABLE);
        await Onyx.set(R1, {v: 1});
        await Onyx.set(R2, {v: 2});
        await Onyx.set(R3, {v: 3});

        await Onyx.mergeCollection(REPORT, {[R1]: {w: 1}, [R2]: {w: 2}});

        expect(cache.getKeyForEviction()).toBe(R3);
        expect(cache.getKeyForEviction(new Set([R3]))).toBe(R1);
    });

    it('drops a removed member from the eviction candidates', async () => {
        const {Onyx, cache} = await startHarness(EVICTABLE);
        await Onyx.set(R1, {v: 1});
        await Onyx.set(R2, {v: 2});

        await Onyx.set(R1, null);
        expect(cache.getKeyForEviction()).toBe(R2);

        await Onyx.multiSet({[R2]: null});
        expect(cache.getKeyForEviction()).toBeUndefined();
    });

    it('tracks direct notifyKey and notifyCollection calls the same way', async () => {
        const {OnyxUtils, cache} = await startHarness(EVICTABLE);

        OnyxUtils.notifyKey(R1, {v: 1});
        OnyxUtils.notifyCollection(REPORT, {[R2]: {v: 2}, [R3]: {v: 3}}, {});
        expect(cache.getKeyForEviction()).toBe(R1);

        OnyxUtils.notifyKey(R1, {v: 11});
        expect(cache.getKeyForEviction()).toBe(R2);

        OnyxUtils.notifyCollection(REPORT, {[R2]: undefined, [R3]: null}, {});
        OnyxUtils.notifyKey(R1, undefined);
        expect(cache.getKeyForEviction()).toBeUndefined();
    });

    it('never lists a collection key or a key outside the evictable collections', async () => {
        const {OnyxUtils, cache} = await startHarness(EVICTABLE);

        OnyxUtils.notifyKey(REPORT, {});
        OnyxUtils.notifyKey<OnyxKey>(KEYS.PLAIN, 'value');
        OnyxUtils.notifyKey(`${KEYS.COLLECTION.REPORT_ACTIONS}1`, {v: 1});

        expect(cache.getKeyForEviction()).toBeUndefined();
    });

    it('tracks a member even when no subscriber listens to it', async () => {
        const {OnyxUtils, cache} = await startHarness(EVICTABLE);

        OnyxUtils.notifyKey(R1, {v: 1});
        OnyxUtils.notifyKey(R2, {v: 2});
        OnyxUtils.notifyKey(R1, undefined);

        expect(cache.getKeyForEviction()).toBe(R2);
    });
});
