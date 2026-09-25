import {randAvatar, randEmail, randWord} from '@ngneat/falso';

import type {PersonalDetails} from '../types';

/** Port of Expensify/App `tests/utils/collections/personalDetails.ts`. */
export default function createPersonalDetails(index: number): PersonalDetails {
    return {
        accountID: index,
        avatar: randAvatar(),
        displayName: randWord(),
        lastName: randWord(),
        login: randEmail(),
    };
}
