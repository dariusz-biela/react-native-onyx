import type {DevtoolsConnection} from '../../../../lib/DevTools';

import Onyx from '../../../../lib';
import RealDevTools from '../../../../lib/DevTools/RealDevTools';
import OnyxUtils from '../../../../lib/OnyxUtils';
import utils from '../../../../lib/utils';
import {KEYS, resetOnyx, settle} from './helpers';

const ROUTES = KEYS.COLLECTION.ROUTES;
const A = `${ROUTES}A`;
const B = `${ROUTES}B`;
const D = `${ROUTES}D`;

const send = jest.fn<void, [Record<string, unknown>, Record<string, unknown>]>();

function lastSent(): {action: Record<string, unknown> | undefined; state: Record<string, unknown> | undefined} {
    const call = send.mock.calls.at(-1);
    return {action: call?.[0], state: call?.[1]};
}

describe('setCollection reported to DevTools', () => {
    beforeAll(async () => {
        const connection: DevtoolsConnection = {send, init: jest.fn(), unsubscribe: jest.fn(), subscribe: jest.fn(() => () => undefined)};
        jest.spyOn(RealDevTools.prototype, 'connectViaExtension').mockReturnValue(connection);
        Onyx.init({keys: KEYS, enableDevTools: true});
        await settle();
    });
    beforeEach(resetOnyx);

    it('reports the replacement with removed members as null and new members set', async () => {
        await Onyx.multiSet({[A]: {name: 'A'}, [B]: {name: 'B'}});
        send.mockClear();

        await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}});

        const {action, state} = lastSent();
        expect(action?.type).toBe(utils.formatActionName(Onyx.METHOD.SET_COLLECTION));
        expect(state).toMatchObject({[A]: {name: 'A2'}, [B]: null, [D]: {name: 'D'}});
    });

    it('reports a partial set without touching untargeted members', async () => {
        await Onyx.multiSet({[A]: {name: 'A'}, [B]: {name: 'B'}});
        send.mockClear();

        await OnyxUtils.partialSetCollection({collectionKey: ROUTES, collection: {[A]: null, [D]: {name: 'D'}}});

        const {action, state} = lastSent();
        expect(action?.type).toBe(utils.formatActionName(Onyx.METHOD.SET_COLLECTION));
        expect(state).toMatchObject({[A]: null, [B]: {name: 'B'}, [D]: {name: 'D'}});
    });
});
