import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';
import type {CollectionKeyBase} from 'react-native-onyx/dist/types';

/**
 * Key lists built out of the app's real `ONYXKEYS`, for the scenarios that measure the key helpers
 * rather than the store. The point of using the real prefixes is that `OnyxKeys` is a prefix matcher:
 * its cost depends on how many collection prefixes are registered, how long they are and how many of
 * them share a leading substring, and the app registers around a hundred of them.
 */

/** Every registered collection prefix, in declaration order. */
function getCollectionPrefixes(): CollectionKeyBase[] {
    return Object.values(ONYXKEYS.COLLECTION);
}

/**
 * `count` collection member keys spread evenly over the real collection prefixes, for example
 * `report_1`, `policy_1`, ... The ids restart per prefix so the same id appears under many
 * collections, which is what a real store looks like.
 */
function buildCollectionMemberKeys(count: number): OnyxKey[] {
    const prefixes = getCollectionPrefixes();
    const keys: OnyxKey[] = new Array<OnyxKey>(count);

    for (let index = 0; index < count; index++) {
        const prefix = prefixes[index % prefixes.length];
        const id = Math.floor(index / prefixes.length) + 1;
        keys[index] = `${prefix}${id}`;
    }

    return keys;
}

export {buildCollectionMemberKeys, getCollectionPrefixes};
