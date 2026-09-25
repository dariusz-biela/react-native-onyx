import type {ValueOf} from 'type-fest';

import {rand, randAvatar, randBoolean, randCurrencyCode, randEmail, randPastDate, randWord} from '@ngneat/falso';

import CONST from '../CONST';
import type {Policy} from '../types';

/** Port of Expensify/App `tests/utils/collections/policies.ts`. */
export default function createRandomPolicy(index: number, type?: ValueOf<typeof CONST.POLICY.TYPE>, name?: string): Policy {
    return {
        id: index.toString(),
        name: name ?? randWord(),
        type: type ?? rand(Object.values(CONST.POLICY.TYPE).filter((policyType) => policyType !== CONST.POLICY.TYPE.SUBMIT)),
        autoReporting: randBoolean(),
        autoReportingFrequency: rand(Object.values(CONST.POLICY.AUTO_REPORTING_FREQUENCIES).filter((frequency) => frequency !== CONST.POLICY.AUTO_REPORTING_FREQUENCIES.MANUAL)),
        harvesting: {
            enabled: randBoolean(),
        },
        autoReportingOffset: 1,
        preventSelfApproval: randBoolean(),
        outputCurrency: randCurrencyCode(),
        role: rand(Object.values(CONST.POLICY.ROLE)),
        owner: randEmail(),
        ownerAccountID: index,
        avatarURL: randAvatar(),
        isFromFullPolicy: randBoolean(),
        lastModified: randPastDate().toISOString(),
        pendingAction: rand(Object.values(CONST.RED_BRICK_ROAD_PENDING_ACTION).filter((action) => action !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE)),
        errors: {},
        customUnits: {},
        errorFields: {},
        approvalMode: rand(Object.values(CONST.POLICY.APPROVAL_MODE)),
    };
}
