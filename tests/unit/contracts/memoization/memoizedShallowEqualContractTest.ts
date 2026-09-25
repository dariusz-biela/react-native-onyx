import memoizedShallowEqual from '../../../../lib/memoizedShallowEqual';

function buildLargeObject(size: number): Record<string, {id: number}> {
    const result: Record<string, {id: number}> = {};
    for (let index = 0; index < size; index++) {
        result[`report_${index}`] = {id: index};
    }
    return result;
}

describe('memoizedShallowEqual contract', () => {
    describe('verdicts for object pairs', () => {
        it.each([
            ['equal primitives in a different key order', {a: 1, b: 'x'}, {b: 'x', a: 1}, true],
            ['equal nested arrays under different references', {nested: [1]}, {nested: [1]}, false],
            ['NaN members', {a: Number.NaN}, {a: Number.NaN}, true],
            ['0 and -0 members', {a: 0}, {a: -0}, true],
            ['members set to undefined under different keys', {a: undefined}, {b: undefined}, false],
            ['a member set to undefined versus a missing member with the same key count', {a: 1, b: undefined}, {a: 1, c: 2}, false],
            ['an undefined member versus a missing member', {a: 1, b: undefined}, {a: 1}, false],
            ['null and undefined members', {a: null}, {a: undefined}, false],
            ['a number and a string member', {a: 1}, {a: '1'}, false],
            ['an array and an object with the same indexes', ['a'], {0: 'a'}, false],
            ['two empty objects', {}, {}, true],
            ['two empty arrays', [], [], true],
            ['an empty object and an empty array', {}, [], false],
            ['arrays with equal members', [1, 'a', null], [1, 'a', null], true],
            ['arrays that differ only in length', [1, 2], [1, 2, undefined], false],
            ['arrays with the same members in a different order', [1, 2], [2, 1], false],
        ])('compares %s', (_description, left: unknown, right: unknown, expected: boolean) => {
            expect(memoizedShallowEqual(left, right)).toBe(expected);
            expect(memoizedShallowEqual(right, left)).toBe(expected);
        });

        it('compares member references, so equal nested content under a new reference is a change', () => {
            const shared = {name: 'John'};

            expect(memoizedShallowEqual({member: shared, count: 1}, {member: shared, count: 1})).toBe(true);
            expect(memoizedShallowEqual({member: shared, count: 1}, {member: {...shared}, count: 1})).toBe(false);
        });

        it('finds a difference in the last member of a large object', () => {
            const left = buildLargeObject(500);
            const equal = {...left};
            const changedLast = {...left, report_499: {id: 499}};
            const extra = {...left, report_500: {id: 500}};

            expect(memoizedShallowEqual(left, equal)).toBe(true);
            expect(memoizedShallowEqual(left, changedLast)).toBe(false);
            expect(memoizedShallowEqual(left, extra)).toBe(false);
            expect(memoizedShallowEqual(extra, left)).toBe(false);
        });

        it('treats a frozen object like a plain one', () => {
            const member = {id: 1};
            const frozen = Object.freeze({member});

            expect(memoizedShallowEqual(frozen, {member})).toBe(true);
            expect(memoizedShallowEqual(frozen, Object.freeze({member: {id: 1}}))).toBe(false);
        });
    });

    describe('verdicts that involve a non-object', () => {
        it.each([
            ['undefined and undefined', undefined, undefined, true],
            ['null and null', null, null, true],
            ['null and undefined', null, undefined, false],
            ['undefined and an empty object', undefined, {}, false],
            ['null and an empty object', null, {}, false],
            ['null and an empty array', null, [], false],
            ['0 and false', 0, false, false],
            ['an empty string and undefined', '', undefined, false],
            ['0 and -0', 0, -0, true],
            ['NaN and NaN', Number.NaN, Number.NaN, true],
            ['a string and an object', 'a', {0: 'a'}, false],
        ])('compares %s', (_description, left: unknown, right: unknown, expected: boolean) => {
            expect(memoizedShallowEqual(left, right)).toBe(expected);
            expect(memoizedShallowEqual(right, left)).toBe(expected);
        });
    });

    describe('memoized verdicts', () => {
        it('keeps verdicts for the same left object apart per right object', () => {
            const left = {a: 1};
            const equal = {a: 1};
            const different = {a: 2};

            expect(memoizedShallowEqual(left, different)).toBe(false);
            expect(memoizedShallowEqual(left, equal)).toBe(true);
            expect(memoizedShallowEqual(left, different)).toBe(false);
        });

        it('keeps verdicts for the same right object apart per left object', () => {
            const right = {a: 1};
            const equal = {a: 1};
            const different = {a: 2};

            expect(memoizedShallowEqual(equal, right)).toBe(true);
            expect(memoizedShallowEqual(different, right)).toBe(false);
            expect(memoizedShallowEqual(equal, right)).toBe(true);
        });

        it('gives the same verdict in both directions and for an object compared with itself', () => {
            const left = {a: 1};
            const right = {a: 1};

            expect(memoizedShallowEqual(left, right)).toBe(true);
            expect(memoizedShallowEqual(right, left)).toBe(true);
            expect(memoizedShallowEqual(left, left)).toBe(true);
            expect(memoizedShallowEqual(right, right)).toBe(true);
        });

        it('returns the same verdict on every repeated call for a pair that differs', () => {
            const left = {a: 1, b: 2};
            const right = {a: 1, b: 3};

            for (let index = 0; index < 5; index++) {
                expect(memoizedShallowEqual(left, right)).toBe(false);
            }
        });

        it('gives the right verdict for many fresh pairs built from one shared left object, as N hooks on one key do', () => {
            const cached = buildLargeObject(20);

            for (let revision = 0; revision < 50; revision++) {
                const changed = revision % 2 === 1;
                const next = changed ? {...cached, report_0: {id: revision}} : {...cached};

                expect(memoizedShallowEqual(cached, next)).toBe(!changed);
                expect(memoizedShallowEqual(cached, next)).toBe(!changed);
            }
        });

        it('mixes object and non-object calls without affecting cached object verdicts', () => {
            const left = {a: 1};
            const right = {a: 1};

            expect(memoizedShallowEqual(left, right)).toBe(true);
            expect(memoizedShallowEqual(left, undefined)).toBe(false);
            expect(memoizedShallowEqual(undefined, right)).toBe(false);
            expect(memoizedShallowEqual(left, null)).toBe(false);
            expect(memoizedShallowEqual(left, right)).toBe(true);
        });
    });
});
