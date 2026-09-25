import ONYXKEYS from '@app/ONYXKEYS';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type ChurnContext = {
    cycles: number;
};

const CHURN_CYCLES = 200;

/**
 * Each cycle disconnects before the callback can fire, so the connection metadata is created and torn down
 * again every time instead of being reused. That is the shape of the one-shot reads the app does at boot and
 * of the connect/disconnect traffic a mounting screen produces.
 */
const connectDisconnectChurn = defineScenario({
    id: 'api/connect-disconnect/churn',
    title: 'two hundred connectWithoutView plus disconnect cycles on one warm key, with no callback in between',
    realUsage: [
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 50, note: 'the one-shot read every derived value does before wiring its dependencies'},
        {file: 'src/libs/cleanupPreMountedDraftReports.ts', line: 46, note: 'connect then disconnect inside the first callback'},
        {file: 'src/libs/actions/TransactionEdit.ts', line: 41, note: 'another connect-then-disconnect read, 45 Onyx.connect sites in src/'},
    ],
    scale: (profile) => ({cycles: CHURN_CYCLES, storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<ChurnContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {cycles: CHURN_CYCLES};
    },
    run: async (context) => {
        for (let index = 0; index < context.cycles; index++) {
            const connection = Onyx.connectWithoutView({
                key: ONYXKEYS.SESSION,
                callback: () => {},
            });
            Onyx.disconnect(connection);
        }

        return {cycles: context.cycles};
    },
});

runScenarios([connectDisconnectChurn]);
