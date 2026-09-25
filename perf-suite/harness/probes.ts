import type {OnyxKey} from 'react-native-onyx';

import type {ComponentType, ReactElement} from 'react';

import {createElement, Fragment} from 'react';

import type {RenderedTree} from './react';

import {actAsync} from './react';
import render from './renderer';

/**
 * `renderProbes` in `react.ts` mounts probes that only know their own index, which is all a mount
 * scenario needs. The scenarios that switch keys, force a parent re-render or read a different key
 * per iteration need the key and a revision to arrive as props instead: a probe reading a mutable
 * module variable during render would be exactly the kind of non-idempotent render the React
 * Compiler (which does compile these suite files) is allowed to skip.
 */
type ProbeProps = {
    /** Position of this probe in the list, so a probe can derive a per-instance key or selector. */
    index: number;

    /** The Onyx key the probe reads, or the base key it derives its own member key from. */
    onyxKey: OnyxKey;

    /** Bumped by the scenario to force every probe to re-render without changing any Onyx data. */
    revision: number;
};

function buildProbeGrid(count: number, Probe: ComponentType<ProbeProps>, onyxKey: OnyxKey, revision: number): ReactElement {
    const children: ReactElement[] = new Array<ReactElement>(count);

    for (let index = 0; index < count; index++) {
        children[index] = createElement(Probe, {key: index, index, onyxKey, revision});
    }

    return createElement(Fragment, null, children);
}

/** Mounts `count` probes, each told its index, the key to read and the current revision. */
async function renderProbeGrid(count: number, Probe: ComponentType<ProbeProps>, onyxKey: OnyxKey, revision = 0): Promise<RenderedTree> {
    const tree = render(buildProbeGrid(count, Probe, onyxKey, revision));
    await actAsync(() => {});

    return tree;
}

/** Re-renders an existing grid with a new key or revision. Both `render` and `rerender` wrap in `act` already. */
async function rerenderProbeGrid(tree: RenderedTree, count: number, Probe: ComponentType<ProbeProps>, onyxKey: OnyxKey, revision: number): Promise<void> {
    tree.rerender(buildProbeGrid(count, Probe, onyxKey, revision));
    await actAsync(() => {});
}

export {buildProbeGrid, renderProbeGrid, rerenderProbeGrid};
export type {ProbeProps};
