import type GenericCollection from '../../../utils/GenericCollection';

import Onyx from '../../../../lib';
import OnyxUtils from '../../../../lib/OnyxUtils';
import {KEYS, readCollection, resetOnyx, settle} from './helpers';

const ROUTES = KEYS.COLLECTION.ROUTES;
const A = `${ROUTES}A`;
const B = `${ROUTES}B`;

describe('setCollection without skippable member IDs configured', () => {
    beforeAll(async () => {
        Onyx.init({keys: KEYS});
        await settle();
    });
    beforeEach(async () => {
        await resetOnyx();
        await Onyx.multiSet({[A]: {name: 'A'}, [B]: {name: 'B'}});
    });
    afterAll(resetOnyx);

    it('does not add removed members to the collection object it was given', async () => {
        const input: GenericCollection = {[A]: {name: 'A2'}};

        await Onyx.setCollection(ROUTES, input);

        expect(input).toEqual({[A]: {name: 'A2'}});
        expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}});
    });

    it('does not mutate the collection object given to a partial set', async () => {
        const input: GenericCollection = {[A]: {name: 'A2', gone: null}, [B]: null};

        await OnyxUtils.partialSetCollection({collectionKey: ROUTES, collection: input});

        expect(input).toEqual({[A]: {name: 'A2', gone: null}, [B]: null});
        expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}});
    });
});
