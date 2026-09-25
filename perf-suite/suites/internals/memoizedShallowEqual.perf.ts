import ONYXKEYS from '@app/ONYXKEYS';
import type {Report} from '@app/types';

import {getHeavyAccount} from '../../fixtures/account';
import requireOnyxModule from '../../harness/optionalOnyxModule';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

// Removed by ONYX-PR#834, so the file is skipped on arms built from it (see runScenarios below).
const memoizedShallowEqual = requireOnyxModule<typeof import('react-native-onyx/dist/memoizedShallowEqual')>('memoizedShallowEqual').default;

/**
 * `memoizedShallowEqual` decides whether a hook's newly computed value counts as a change, so it runs
 * once per subscriber per write. One iteration walks its four cases: the same reference, two
 * different objects with equal content, two that differ, and a large object pair (a whole report,
 * which is what a collection member comparison actually looks like).
 */
type ShallowEqualContext = {
    sameReference: Report;
    equalContent: Report;
    differentContent: Report;
    largeLeft: Record<string, Report>;
    largeRight: Record<string, Report>;
    state: {revision: number};
};

const CALLS_PER_CASE = 2000;

const shallowEqualCases = defineScenario({
    id: 'internals/memoizedShallowEqual/cases',
    title: 'two thousand calls each of the equal-reference, equal-content, different-content and large-object cases',
    realUsage: [
        {file: 'src/hooks/useOnyx.ts', line: 75, note: 'every hook compares its new value with the previous one through this function'},
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a collection subscriber whose comparison is the large-object case'},
    ],
    // The large-object case compares the whole report collection, so it grows with the reports of the scale.
    scale: (profile) => ({callsPerCase: CALLS_PER_CASE, reports: profile.reports}),
    setup: async (): Promise<ShallowEqualContext> => {
        const account = getHeavyAccount();
        const report = account.reports[`${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`];

        if (!report) {
            throw new Error('The heavy account fixture has no reports.');
        }

        const largeLeft: Record<string, Report> = {};
        const largeRight: Record<string, Report> = {};

        for (const [key, member] of Object.entries(account.reports)) {
            if (!member) {
                continue;
            }

            largeLeft[key] = member;
            largeRight[key] = member;
        }

        return {
            sameReference: report,
            equalContent: {...report},
            differentContent: {...report, lastMessageText: 'different'},
            largeLeft,
            largeRight,
            state: {revision: 0},
        };
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // A fresh pair of objects every iteration, so the identity-pair memo inside the function cannot
        // answer from the previous iteration's verdict.
        context.equalContent = {...context.sameReference};
        context.differentContent = {...context.sameReference, lastMessageText: `revision ${context.state.revision}`};
        context.largeRight = {...context.largeLeft};
    },
    run: async (context, params) => {
        let equal = 0;

        for (let index = 0; index < CALLS_PER_CASE; index++) {
            if (memoizedShallowEqual(context.sameReference, context.sameReference)) {
                equal++;
            }

            if (memoizedShallowEqual(context.sameReference, context.equalContent)) {
                equal++;
            }

            if (memoizedShallowEqual(context.sameReference, context.differentContent)) {
                equal++;
            }

            if (memoizedShallowEqual(context.largeLeft, context.largeRight)) {
                equal++;
            }
        }

        return {callsPerCase: params.callsPerCase, equal};
    },
});

runScenarios([shallowEqualCases], {requiresOnyxModules: ['memoizedShallowEqual']});
