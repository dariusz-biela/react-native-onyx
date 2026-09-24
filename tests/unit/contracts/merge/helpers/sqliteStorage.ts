/**
 * A storage facade backed by the real `SQLiteProvider` on `better-sqlite3`, used in place of the in-memory
 * mock so the native variant's `mergeItem(batchedChanges, replaceNullPatches)` runs through the actual
 * JSON_PATCH and JSON_REPLACE queries. Test files install it with:
 *
 * jest.mock('../../../../lib/storage', () => require('./helpers/sqliteStorage'));
 */
import type {OnyxKey} from '../../../../../lib/types';

import SQLiteProvider from '../../../../../lib/storage/providers/SQLiteProvider';
import {StorageErrorClass} from '../../../../../lib/storage/errors';

jest.mock('react-native-nitro-sqlite', () => require('../../../mocks/sqliteMock'));
jest.mock('react-native-device-info', () => ({getFreeDiskStorage: () => Number.MAX_SAFE_INTEGER}));

const storage = {
    init: jest.fn(() => SQLiteProvider.init()),
    classifyError: jest.fn(() => StorageErrorClass.UNKNOWN),
    getStorageProvider: jest.fn(() => SQLiteProvider),
    keepInstancesSync: jest.fn(),
    getItem: jest.fn(SQLiteProvider.getItem),
    multiGet: jest.fn(SQLiteProvider.multiGet),
    setItem: jest.fn(SQLiteProvider.setItem),
    multiSet: jest.fn(SQLiteProvider.multiSet),
    mergeItem: jest.fn(SQLiteProvider.mergeItem),
    multiMerge: jest.fn(SQLiteProvider.multiMerge),
    removeItem: jest.fn(SQLiteProvider.removeItem),
    removeItems: jest.fn(SQLiteProvider.removeItems),
    clear: jest.fn(SQLiteProvider.clear),
    getAllKeys: jest.fn(SQLiteProvider.getAllKeys),
    getAll: jest.fn(SQLiteProvider.getAll),
    getDatabaseSize: jest.fn(() => Promise.resolve({bytesUsed: 0, bytesRemaining: Number.MAX_SAFE_INTEGER})),
};

/** What SQLite holds for a key right now, `null` when there is no row, read around Onyx so nothing is cached. */
function readStored(key: OnyxKey): Promise<unknown> {
    return SQLiteProvider.getItem(key);
}

/** Writes straight into SQLite, bypassing Onyx, to model a value persisted by an earlier session. */
function writeStored(key: OnyxKey, value: unknown): Promise<void> {
    return SQLiteProvider.setItem(key, value);
}

/** Deletes the row straight from SQLite, bypassing Onyx. */
function removeStored(key: OnyxKey): Promise<void> {
    return SQLiteProvider.removeItem(key);
}

function wipeStorage(): Promise<void> {
    return SQLiteProvider.clear();
}

/** The calls that changed persisted data, so a test can check that an unchanged merge writes nothing. */
function storageWriteCallCount(): number {
    return [storage.setItem, storage.multiSet, storage.mergeItem, storage.multiMerge, storage.removeItem, storage.removeItems].reduce((total, method) => total + method.mock.calls.length, 0);
}

if (expect.getState().testPath === __filename) {
    describe('sqlite storage facade', () => {
        beforeAll(() => storage.init());

        it('applies a replace-null patch on top of JSON_PATCH', async () => {
            await writeStored('key', {outer: {old: 1}, kept: 1});
            await storage.mergeItem('key', {outer: {ONYX_INTERNALS__REPLACE_OBJECT_MARK: true, fresh: 1}}, [[['outer'], {fresh: 1}]]);
            expect(await readStored('key')).toStrictEqual({outer: {fresh: 1}, kept: 1});
            expect(storageWriteCallCount()).toBe(1);
        });
    });
}

export {readStored, removeStored, storageWriteCallCount, wipeStorage, writeStored};
export default storage;
