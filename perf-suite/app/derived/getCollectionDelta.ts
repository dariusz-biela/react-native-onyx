/**
 * Port of Expensify/App `src/libs/getCollectionDelta.ts`: the members that changed between two snapshots of a
 * collection, found by reference because Onyx keeps unchanged members' references. A missing snapshot counts as
 * an empty collection. Returns `undefined` when nothing changed.
 */
type CollectionSnapshot = Record<string, unknown> | undefined;

function getCollectionDelta(current: CollectionSnapshot, previous: CollectionSnapshot): Record<string, unknown> | undefined {
    if (current === previous) {
        return undefined;
    }

    const delta: Record<string, unknown> = {};
    let hasChanges = false;

    if (current) {
        for (const key of Object.keys(current)) {
            if (current[key] === previous?.[key]) {
                continue;
            }
            delta[key] = current[key];
            hasChanges = true;
        }
    }

    if (previous) {
        for (const key of Object.keys(previous)) {
            if (current && key in current) {
                continue;
            }
            delta[key] = undefined;
            hasChanges = true;
        }
    }

    return hasChanges ? delta : undefined;
}

export default getCollectionDelta;
export type {CollectionSnapshot};
