/**
 * Counts what the page asks of the browser's IndexedDB, by patching the prototypes every connection shares:
 * `IDBKeyValProvider` and idb-keyval call only `transaction`, `get`, `put` and `delete` on the paths the
 * storage rows measure. The patches add a counter bump to each call and nothing else, so the timed work is
 * the browser's own: structured clones, the IPC to the storage service and the backend commit.
 */
type IDBCounters = {
    readTransactions: number;
    writeTransactions: number;

    /** `IDBObjectStore.get` calls, each a value structured-cloned out of the store. */
    reads: number;

    /** `IDBObjectStore.put` calls, each a value structured-cloned into the store. */
    writes: number;
    deletes: number;
};

const counters: IDBCounters = {readTransactions: 0, writeTransactions: 0, reads: 0, writes: 0, deletes: 0};

let pendingTransactions = 0;
let idleWaiters: Array<() => void> = [];
let isInstalled = false;

function settleTransaction() {
    pendingTransactions--;

    if (pendingTransactions > 0) {
        return;
    }

    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
}

function trackTransaction(transaction: IDBTransaction) {
    if (transaction.mode === 'readonly') {
        counters.readTransactions++;
    } else {
        counters.writeTransactions++;
    }

    pendingTransactions++;
    let isSettled = false;
    const onSettled = () => {
        if (isSettled) {
            return;
        }
        isSettled = true;
        settleTransaction();
    };

    transaction.addEventListener('complete', onSettled);
    transaction.addEventListener('abort', onSettled);
}

function installIDBCounters(): void {
    if (isInstalled) {
        return;
    }
    isInstalled = true;

    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function countedTransaction(this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        const created = transaction.apply(this, args);
        trackTransaction(created);
        return created;
    };

    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function countedGet(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['get']>) {
        counters.reads++;
        return get.apply(this, args);
    };

    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function countedPut(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        counters.writes++;
        return put.apply(this, args);
    };

    const deleteRecord = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function countedDelete(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
        counters.deletes++;
        return deleteRecord.apply(this, args);
    };
}

function resetIDBCounters(): void {
    counters.readTransactions = 0;
    counters.writeTransactions = 0;
    counters.reads = 0;
    counters.writes = 0;
    counters.deletes = 0;
}

function readIDBCounters(): IDBCounters {
    return {...counters};
}

/** Resolves once every transaction opened so far has committed or aborted, so no write spills into the next iteration. */
function whenIDBIdle(): Promise<void> {
    if (pendingTransactions === 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        idleWaiters.push(resolve);
    });
}

export {installIDBCounters, readIDBCounters, resetIDBCounters, whenIDBIdle};
export type {IDBCounters};
