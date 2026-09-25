import type {OnyxEntry} from 'react-native-onyx';

import type {PersonalDetailsList, Session} from './types';

/** Mirrors `sessionEmailAndAccountIDSelector` in Expensify/App `src/selectors/Session.ts`. */
const sessionEmailAndAccountIDSelector = (session: OnyxEntry<Session>) => ({email: session?.email, accountID: session?.accountID});

/** Mirrors `personalDetailsLoginSelector` in Expensify/App `src/selectors/PersonalDetails.ts`. */
const personalDetailsLoginSelector = (accountID: number | undefined) => (personalDetailsList: OnyxEntry<PersonalDetailsList>) =>
    accountID ? personalDetailsList?.[accountID]?.login : undefined;

export {personalDetailsLoginSelector, sessionEmailAndAccountIDSelector};
