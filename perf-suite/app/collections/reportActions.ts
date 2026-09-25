import {rand, randAggregation, randBoolean, randWord} from '@ngneat/falso';
import {format} from 'date-fns';

import CONST from '../CONST';
import type {ReportAction} from '../types';

/** Port of Expensify/App `tests/utils/collections/reportActions.ts`. */
const deprecatedReportActions: readonly string[] = [
    CONST.REPORT.ACTIONS.TYPE.DELETED_ACCOUNT,
    CONST.REPORT.ACTIONS.TYPE.REIMBURSEMENT_REQUESTED,
    CONST.REPORT.ACTIONS.TYPE.REIMBURSEMENT_SETUP_REQUESTED,
    CONST.REPORT.ACTIONS.TYPE.DONATION,
    CONST.REPORT.ACTIONS.TYPE.REIMBURSED,
];

const flattenActionNamesValues = (actionNames: object): string[] => {
    let result: string[] = [];
    for (const value of Object.values(actionNames)) {
        if (typeof value === 'object' && value !== null) {
            result = result.concat(flattenActionNamesValues(value));
        } else if (typeof value === 'string') {
            result.push(value);
        }
    }
    return result;
};

const getRandomDate = (): string => {
    const randomTimestamp = Math.random() * new Date().getTime();
    const randomDate = new Date(randomTimestamp);

    return format(randomDate, CONST.DATE.FNS_DB_FORMAT_STRING);
};

export default function createRandomReportAction(index: number): ReportAction {
    return {
        actionName: rand(flattenActionNamesValues(CONST.REPORT.ACTIONS.TYPE).filter((actionType) => !deprecatedReportActions.includes(actionType))),
        reportActionID: index.toString(),
        actorAccountID: index,
        person: [
            {
                type: randWord(),
                style: randWord(),
                text: randWord(),
            },
        ],
        created: getRandomDate(),
        message: [
            {
                type: randWord(),
                html: randWord(),
                style: randWord(),
                text: randWord(),
                isEdited: randBoolean(),
                isDeletedParentAction: randBoolean(),
                whisperedTo: randAggregation(),
            },
        ],
        originalMessage: {
            html: randWord(),
            lastModified: getRandomDate(),
            whisperedTo: randAggregation(),
        },
        avatar: randWord(),
        automatic: randBoolean(),
        shouldShow: randBoolean(),
        lastModified: getRandomDate(),
        delegateAccountID: index,
        errors: {},
        isAttachmentOnly: randBoolean(),
    };
}

export {getRandomDate};
