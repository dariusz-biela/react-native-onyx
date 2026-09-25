import createMemoizedSelector from '../../../../lib/createMemoizedSelector';

type Person = {id: number; name: string; tags?: string[]};

type Row = {id: number; title: string};

function selectIdentity(person: Person | undefined): {id: number | undefined} {
    return {id: person?.id};
}

describe('createMemoizedSelector contract', () => {
    describe('output identity on a miss', () => {
        it('returns the exact reference the selector produced on the first call', () => {
            const produced = {id: 1};
            const memoized = createMemoizedSelector(() => produced);

            expect(memoized(undefined)).toBe(produced);
        });

        it('returns the exact reference the selector produced when a new input changes the output', () => {
            const produced: Array<{id: number}> = [];
            const memoized = createMemoizedSelector((person: Person) => {
                const output = {id: person.id};
                produced.push(output);
                return output;
            });

            memoized({id: 1, name: 'a'});
            const second = memoized({id: 2, name: 'a'});

            expect(second).toBe(produced[1]);
        });

        it('passes through a sub-object of the input by reference so it stays identical to the stored value', () => {
            const tags = ['x'];
            const memoized = createMemoizedSelector((person: Person) => person.tags);

            expect(memoized({id: 1, name: 'a', tags})).toBe(tags);

            const nextTags = ['y'];
            expect(memoized({id: 1, name: 'a', tags: nextTags})).toBe(nextTags);
        });
    });

    describe('output identity on a deep-equal miss', () => {
        it('keeps the most recent distinct output, not the first one, after the output changed and came back to an equal shape', () => {
            const memoized = createMemoizedSelector(selectIdentity);

            const first = memoized({id: 1, name: 'a'});
            const second = memoized({id: 2, name: 'a'});
            const third = memoized({id: 2, name: 'b'});

            expect(second).not.toBe(first);
            expect(third).toBe(second);
        });

        it('keeps the same reference across many alternating inputs whose outputs are all deep equal', () => {
            const memoized = createMemoizedSelector((rows: Record<string, Row>) => Object.values(rows).map((row) => ({id: row.id, title: row.title})));
            const rows: Record<string, Row> = {row_1: {id: 1, title: 'one'}, row_2: {id: 2, title: 'two'}};

            const first = memoized(rows);
            for (let index = 0; index < 50; index++) {
                expect(memoized({...rows})).toBe(first);
                expect(memoized(rows)).toBe(first);
            }
        });

        it('compares nested arrays and objects by content, regardless of key order', () => {
            const memoized = createMemoizedSelector((input: {order: number}) =>
                input.order === 0 ? {a: 1, nested: {list: [1, 2], flag: true}} : {nested: {flag: true, list: [1, 2]}, a: 1},
            );

            const first = memoized({order: 0});

            expect(memoized({order: 1})).toBe(first);
        });

        it('treats NaN as equal to NaN and 0 as equal to -0 in the output', () => {
            const memoized = createMemoizedSelector((input: {zero: number}) => ({value: Number.NaN, zero: input.zero}));

            const first = memoized({zero: 0});

            expect(memoized({zero: -0})).toBe(first);
        });
    });

    describe('what counts as a changed output', () => {
        it.each([
            ['a property set to undefined versus a missing property', {a: 1, b: undefined}, {a: 1}],
            ['an array versus an object with the same indexes', ['a'], {0: 'a'}],
            ['a number versus the same digits as a string', {a: 1}, {a: '1'}],
            ['null versus undefined', null, undefined],
            ['a change deep inside a nested array', {list: [{id: 1, tags: ['a']}]}, {list: [{id: 1, tags: ['b']}]}],
            ['arrays of different length', [1, 2], [1, 2, 3]],
            ['an empty object versus an empty array', {}, []],
            ['false versus 0', false, 0],
            ['an empty string versus undefined', '', undefined],
        ])('returns the new output for %s', (_description, firstOutput: unknown, secondOutput: unknown) => {
            const memoized = createMemoizedSelector((input: {first: boolean}) => (input.first ? firstOutput : secondOutput));

            expect(memoized({first: true})).toBe(firstOutput);
            expect(memoized({first: false})).toBe(secondOutput);
        });

        it('returns every output of a changing sequence in order and ends on the last one', () => {
            const memoized = createMemoizedSelector((count: {value: number}) => ({parity: count.value % 2}));
            const outputs = [0, 1, 2, 3, 4, 5].map((value) => memoized({value}));

            expect(outputs.map((output) => output.parity)).toEqual([0, 1, 0, 1, 0, 1]);
            for (let index = 1; index < outputs.length; index++) {
                expect(outputs[index]).not.toBe(outputs[index - 1]);
            }
        });
    });

    describe('hits', () => {
        it('does not call the selector again for the input that produced a deep-equal output', () => {
            const selector = jest.fn(selectIdentity);
            const memoized = createMemoizedSelector(selector);
            const first = {id: 1, name: 'a'};
            const second = {id: 1, name: 'b'};

            memoized(first);
            memoized(second);
            const result = memoized(second);

            expect(selector).toHaveBeenCalledTimes(2);
            expect(result).toEqual({id: 1});
        });

        it('does not call the selector again for the input that produced a changed output', () => {
            const selector = jest.fn(selectIdentity);
            const memoized = createMemoizedSelector(selector);
            const second = {id: 2, name: 'b'};

            memoized({id: 1, name: 'a'});
            const changed = memoized(second);

            expect(memoized(second)).toBe(changed);
            expect(selector).toHaveBeenCalledTimes(2);
        });

        it.each([
            ['null', null],
            ['zero', 0],
            ['an empty string', ''],
            ['false', false],
        ])('hits on a repeated %s input', (_description, input: unknown) => {
            const selector = jest.fn((value: unknown) => ({value}));
            const memoized = createMemoizedSelector(selector);

            const first = memoized(input);

            expect(memoized(input)).toBe(first);
            expect(selector).toHaveBeenCalledTimes(1);
        });

        it('runs the selector on the first call even when the input is undefined', () => {
            const selector = jest.fn((value: Person | undefined) => (value === undefined ? 'fallback' : value.name));
            const memoized = createMemoizedSelector(selector);

            expect(memoized(undefined)).toBe('fallback');
            expect(selector).toHaveBeenCalledTimes(1);
        });

        it('passes the input to the selector unchanged', () => {
            const selector = jest.fn((value: Person) => value.id);
            const memoized = createMemoizedSelector(selector);
            const input = {id: 1, name: 'a'};

            memoized(input);

            expect(selector).toHaveBeenCalledWith(input);
            expect(selector.mock.calls[0][0]).toBe(input);
        });
    });

    describe('invalidation', () => {
        it('re-runs the selector for an input seen before the last one, so a selector reading outside state stays current', () => {
            let suffix = 'first';
            const selector = jest.fn((person: Person) => `${person.name}-${suffix}`);
            const memoized = createMemoizedSelector(selector);
            const personA = {id: 1, name: 'a'};
            const personB = {id: 2, name: 'b'};

            expect(memoized(personA)).toBe('a-first');
            expect(memoized(personB)).toBe('b-first');
            suffix = 'second';

            expect(memoized(personA)).toBe('a-second');
            expect(selector).toHaveBeenCalledTimes(3);
        });

        it('returns a value equal to the recomputed output, not the older output of the same input, when coming back to an earlier input', () => {
            const memoized = createMemoizedSelector(selectIdentity);
            const personA = {id: 1, name: 'a'};

            const firstA = memoized(personA);
            const onB = memoized({id: 2, name: 'b'});
            const againA = memoized(personA);

            expect(againA).toEqual({id: 1});
            expect(againA).not.toBe(onB);
            expect(firstA).toEqual(againA);
        });
    });

    describe('errors', () => {
        it('does not cache a thrown error and runs the selector again for the same input', () => {
            let shouldThrow = true;
            const selector = jest.fn((person: Person) => {
                if (shouldThrow) {
                    throw new Error('broken');
                }
                return person.name;
            });
            const memoized = createMemoizedSelector(selector);
            const input = {id: 1, name: 'a'};

            expect(() => memoized(input)).toThrow('broken');
            shouldThrow = false;

            expect(memoized(input)).toBe('a');
            expect(selector).toHaveBeenCalledTimes(2);
        });

        it('never serves the previous output for an input whose selector call threw', () => {
            let shouldThrow = false;
            const memoized = createMemoizedSelector((person: Person) => {
                if (shouldThrow) {
                    throw new Error('broken');
                }
                return {name: person.name};
            });
            const personA = {id: 1, name: 'a'};
            const personB = {id: 2, name: 'b'};

            const onA = memoized(personA);
            shouldThrow = true;
            expect(() => memoized(personB)).toThrow('broken');
            expect(() => memoized(personB)).toThrow('broken');
            shouldThrow = false;

            expect(memoized(personB)).toEqual({name: 'b'});
            expect(memoized(personA)).toEqual(onA);
        });

        it('keeps the output of the last successful input after a failed call on another input', () => {
            let shouldThrow = false;
            const selector = jest.fn((person: Person) => {
                if (shouldThrow) {
                    throw new Error('broken');
                }
                return {name: person.name};
            });
            const memoized = createMemoizedSelector(selector);
            const personA = {id: 1, name: 'a'};

            const onA = memoized(personA);
            shouldThrow = true;
            expect(() => memoized({id: 2, name: 'b'})).toThrow('broken');
            shouldThrow = false;

            expect(memoized({id: 1, name: 'a'})).toBe(onA);
        });
    });

    describe('per-wrapper separation', () => {
        it('keeps two wrappers of the same selector function independent', () => {
            const selector = jest.fn(selectIdentity);
            const first = createMemoizedSelector(selector);
            const second = createMemoizedSelector(selector);
            const personA = {id: 1, name: 'a'};
            const personB = {id: 2, name: 'b'};

            const onA = first(personA);
            const onB = second(personB);

            expect(onB).toEqual({id: 2});
            expect(first(personA)).toBe(onA);
            expect(second(personB)).toBe(onB);
            expect(selector).toHaveBeenCalledTimes(2);
        });

        it('does not let one wrapper hand its previous output to another wrapper whose output is deep equal', () => {
            const selector = (person: Person) => ({id: person.id});
            const first = createMemoizedSelector(selector);
            const second = createMemoizedSelector(selector);

            const fromFirst = first({id: 1, name: 'a'});
            const fromSecond = second({id: 1, name: 'b'});

            expect(fromSecond).toEqual(fromFirst);
            expect(fromSecond).not.toBe(fromFirst);
        });

        it('keeps the cache of one wrapper when another wrapper of the same selector sees a different input', () => {
            const selector = jest.fn((person: Person) => ({name: person.name}));
            const first = createMemoizedSelector(selector);
            const second = createMemoizedSelector(selector);
            const personA = {id: 1, name: 'a'};

            const onA = first(personA);
            second({id: 2, name: 'b'});
            second({id: 3, name: 'c'});

            expect(first(personA)).toBe(onA);
            expect(selector).toHaveBeenCalledTimes(3);
        });
    });
});
