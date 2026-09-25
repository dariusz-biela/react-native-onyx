import ONYXKEYS from '@app/ONYXKEYS';
import type {OnyxKey} from 'react-native-onyx';

/**
 * Copied verbatim from `KEYS_TO_PRESERVE_ON_SIGN_OUT` in `src/libs/actions/SignInRedirect.ts:53-65`,
 * the list `clearStorageAndRedirect` passes to `Onyx.clear` at `:104`.
 *
 * Importing that module would run its four module-level `Onyx.connectWithoutView` calls and pull in the
 * HybridApp native module, neither of which belongs inside a measurement of `Onyx.clear`. If the list
 * changes in `src/`, this copy has to be updated with it.
 */
const KEYS_TO_PRESERVE_ON_SIGN_OUT: OnyxKey[] = [
    ONYXKEYS.NVP_PREFERRED_LOCALE,
    ONYXKEYS.RAM_ONLY_ARE_TRANSLATIONS_LOADING,
    ONYXKEYS.PREFERRED_THEME,
    ONYXKEYS.NVP_SEARCH_SIDEBAR,
    ONYXKEYS.ACTIVE_CLIENTS,
    ONYXKEYS.DEVICE_ID,
    ONYXKEYS.ACTIVE_SERVER,
    ONYXKEYS.IS_DEBUG_MODE_ENABLED,
    ONYXKEYS.BETA_OVERRIDES,
    ONYXKEYS.COLLECTION.PASSKEY_CREDENTIALS,
    ONYXKEYS.COLLECTION.DEVICE_BIOMETRICS,
];

export default KEYS_TO_PRESERVE_ON_SIGN_OUT;
