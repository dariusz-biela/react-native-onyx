import type {CollectionSnapshot} from './getCollectionDelta';

/**
 * The stand-in for the App's derived configs. The App's computes are App code, and the suite measures Onyx, so every
 * derived key gets the same compute with the shape the App's incremental configs have: a full pass over the source
 * dependency when there is no previous value, otherwise a shallow copy of the previous value with only the changed
 * members redone. The source is the first collection dependency, or the first dependency when there is none.
 */
type MemberAttributes = {
    isEmpty: boolean;
    fieldCount: number;
};

type SyntheticValue = Record<string, MemberAttributes>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isMemberAttributes(value: unknown): value is MemberAttributes {
    return isRecord(value) && typeof value.isEmpty === 'boolean' && typeof value.fieldCount === 'number';
}

/** Reads a value hydrated from storage, which the engine cannot trust to have the shape it wrote. */
function toSyntheticValue(stored: unknown): SyntheticValue | undefined {
    if (!isRecord(stored)) {
        return undefined;
    }

    const value: SyntheticValue = {};
    for (const [memberKey, attributes] of Object.entries(stored)) {
        if (isMemberAttributes(attributes)) {
            value[memberKey] = attributes;
        }
    }

    return value;
}

function computeMemberAttributes(member: unknown): MemberAttributes {
    return {
        isEmpty: !isRecord(member),
        fieldCount: isRecord(member) ? Object.keys(member).length : 0,
    };
}

function computeFromScratch(source: unknown): SyntheticValue {
    const value: SyntheticValue = {};

    if (!isRecord(source)) {
        return value;
    }

    for (const [memberKey, member] of Object.entries(source)) {
        value[memberKey] = computeMemberAttributes(member);
    }

    return value;
}

/**
 * `sourceDelta` holds the source's changed members since the last flush. It is `undefined` when this flush has no
 * member delta: the first flush, a non-collection source, or a flush that other dependencies triggered.
 */
function computeSyntheticValue(source: unknown, currentValue: SyntheticValue | undefined, sourceDelta: CollectionSnapshot, isCollectionSource: boolean): SyntheticValue {
    if (!currentValue || !isCollectionSource) {
        return computeFromScratch(source);
    }

    const value: SyntheticValue = {...currentValue};

    for (const [memberKey, member] of Object.entries(sourceDelta ?? {})) {
        if (member === undefined) {
            delete value[memberKey];
            continue;
        }
        value[memberKey] = computeMemberAttributes(member);
    }

    return value;
}

export default computeSyntheticValue;
export {isRecord, toSyntheticValue};
export type {SyntheticValue};
