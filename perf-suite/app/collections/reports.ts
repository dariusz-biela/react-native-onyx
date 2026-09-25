import type {ValueOf} from 'type-fest';

import {randBoolean, randCurrencyCode, randWord} from '@ngneat/falso';

import type CONST from '../CONST';
import type {Report} from '../types';

/** Port of `createRandomReport` in Expensify/App `tests/utils/collections/reports.ts`. */
function createRandomReport(index: number, chatType?: ValueOf<typeof CONST.REPORT.CHAT_TYPE>): Report {
    return {
        reportID: index.toString(),
        chatType,
        currency: randCurrencyCode(),
        ownerAccountID: index,
        isPinned: randBoolean(),
        isOwnPolicyExpenseChat: randBoolean(),
        isWaitingOnBankAccount: randBoolean(),
        policyID: index.toString(),
        reportName: randWord(),
    };
}

export {createRandomReport};
