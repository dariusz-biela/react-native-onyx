import type OnyxInstance from '../../../../lib/Onyx';
import type OnyxCacheInstance from '../../../../lib/OnyxCache';
import type MockedStorage from '../../../../lib/storage/__mocks__';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN_A: 'plainA',
    WITH_DEFAULT: 'withDefault',
    PERSISTED: 'persisted',
    COLLECTION: {
        TEST: 'test_',
    },
};

type Modules = {Onyx: typeof OnyxInstance; cache: typeof OnyxCacheInstance; storage: typeof MockedStorage};

function loadFreshOnyx(): Modules {
    let modules: Modules | undefined;
    jest.isolateModules(() => {
        modules = {
            Onyx: require('../../../../lib').default,
            cache: require('../../../../lib/OnyxCache').default,
            storage: require('../../../../lib/storage').default,
        };
    });
    if (!modules) {
        throw new Error('Onyx modules failed to load');
    }
    return modules;
}

describe('Onyx.multiSet called before Onyx.init', () => {
    it('applies the batch after init, over initialKeyStates defaults and persisted values', async () => {
        const {Onyx, cache, storage} = loadFreshOnyx();
        await storage.setItem(KEYS.PERSISTED, 'from storage');

        const deliveries: unknown[] = [];
        let isResolved = false;
        const promise = Onyx.multiSet({
            [KEYS.PLAIN_A]: 'a',
            [KEYS.WITH_DEFAULT]: 'custom',
            [KEYS.PERSISTED]: null,
            [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
        }).then(() => {
            isResolved = true;
        });
        await waitForPromisesToResolve();

        expect(isResolved).toBe(false);
        expect(cache.get(KEYS.PLAIN_A)).toBeUndefined();

        Onyx.init({keys: KEYS, initialKeyStates: {[KEYS.WITH_DEFAULT]: 'default'}});
        Onyx.connect({key: KEYS.WITH_DEFAULT, callback: (value: unknown) => deliveries.push(value)});
        await promise;
        await waitForPromisesToResolve();

        expect(isResolved).toBe(true);
        expect(cache.get(KEYS.PLAIN_A)).toBe('a');
        expect(cache.get(KEYS.WITH_DEFAULT)).toBe('custom');
        expect(cache.get(KEYS.PERSISTED)).toBeUndefined();
        expect(cache.get(`${KEYS.COLLECTION.TEST}1`)).toEqual({id: 1});
        expect(storage.getMockStore()[KEYS.WITH_DEFAULT]).toBe('custom');
        expect(storage.getMockStore()[KEYS.PLAIN_A]).toBe('a');
        expect(Object.prototype.hasOwnProperty.call(storage.getMockStore(), KEYS.PERSISTED)).toBe(false);
        expect(deliveries.at(-1)).toBe('custom');
    });
});
