/**
 * A switchable stand-in for `lib/OnyxMerge`. Jest resolves `OnyxMerge` to the web `index.ts`, but the
 * mobile apps run `index.native.ts`, so the contract tests run every case against both. Install with:
 *
 * jest.mock('../../../../lib/OnyxMerge', () => require('./helpers/mergeVariant'));
 */
import type {ApplyMerge} from '../../../../../lib/OnyxMerge/types';

type MergeVariant = 'web' | 'native';

type OnyxMergeModule = {default: {applyMerge: ApplyMerge}};

const MERGE_VARIANTS: readonly MergeVariant[] = ['web', 'native'];

function loadVariant(variant: MergeVariant): ApplyMerge {
    const module: OnyxMergeModule = variant === 'web' ? jest.requireActual('../../../../../lib/OnyxMerge/index.ts') : jest.requireActual('../../../../../lib/OnyxMerge/index.native.ts');
    return module.default.applyMerge;
}

let activeVariant: MergeVariant = 'web';

function setMergeVariant(variant: MergeVariant): void {
    activeVariant = variant;
}

const applyMerge: ApplyMerge = (key, existingValue, validChanges) => loadVariant(activeVariant)(key, existingValue, validChanges);

if (expect.getState().testPath === __filename) {
    describe('merge variant switch', () => {
        it('loads two distinct implementations', () => {
            expect(loadVariant('web')).not.toBe(loadVariant('native'));
        });
    });
}

export type {MergeVariant};
export {MERGE_VARIANTS, applyMerge, loadVariant, setMergeVariant};
export default {applyMerge};
