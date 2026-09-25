import type {OnyxInput, OnyxKey, OnyxValue} from 'react-native-onyx';

/** A handful of Onyx keys and their values, which is all a scenario ever builds. */
type PartialOnyxRecord = Partial<Record<OnyxKey, OnyxValue<OnyxKey>>>;

/** The same, for the write side: what a scenario hands to the storage-preparation helpers. */
type PartialOnyxInputRecord = Partial<Record<OnyxKey, OnyxInput<OnyxKey>>>;

/**
 * The internal cache writers (`OnyxCache.merge`, `OnyxCache.hydrate`) take
 * `Record<OnyxKey, OnyxValue<OnyxKey>>`. With the app's key augmentation applied, `OnyxKey` is a union
 * of roughly 560 string literals plus the collection patterns, so that mapped type demands every one
 * of those literals to be present. Onyx itself only ever passes partial maps into it, and no
 * narrowing can turn a partial object into a total map, so the assertion lives here, once, instead of
 * in every scenario that has to call one of those methods.
 */
function toOnyxKeyRecord(data: PartialOnyxRecord): Record<OnyxKey, OnyxValue<OnyxKey>> {
    // eslint-disable-next-line no-restricted-syntax
    return data as Record<OnyxKey, OnyxValue<OnyxKey>>;
}

/** The write-side twin of `toOnyxKeyRecord`, for `OnyxUtils.prepareKeyValuePairsForStorage` and friends. */
function toOnyxInputRecord(data: PartialOnyxInputRecord): Record<OnyxKey, OnyxInput<OnyxKey>> {
    // eslint-disable-next-line no-restricted-syntax
    return data as Record<OnyxKey, OnyxInput<OnyxKey>>;
}

export default toOnyxKeyRecord;
export {toOnyxInputRecord};
export type {PartialOnyxInputRecord, PartialOnyxRecord};
