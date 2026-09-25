import type {ComponentType, ReactElement} from 'react';

import {act, createElement, Fragment} from 'react';

import type {RenderedTree} from './renderer';

import render from './renderer';

/**
 * The hook scenarios mount through `./renderer`, the same test renderer setup Expensify/App's hook tests run on.
 * JSX is avoided here on purpose: the harness stays a `.ts` file and the suites keep the JSX.
 */

/** Runs an async update inside `act`, so React flushes before the timed region ends. */
async function actAsync(callback: () => Promise<void> | void): Promise<void> {
    await act(async () => {
        await callback();
    });
}

function buildProbeList(count: number, Probe: ComponentType<{index: number}>): ReactElement {
    const children: ReactElement[] = [];

    for (let index = 0; index < count; index++) {
        children.push(createElement(Probe, {key: index, index}));
    }

    return createElement(Fragment, null, children);
}

/**
 * Mounts `count` copies of a probe component under one parent. `render` already wraps the commit in
 * `act` itself, so it must not be nested inside another `act` call; the empty `actAsync` afterwards
 * flushes whatever the mount scheduled.
 */
async function renderProbes(count: number, Probe: ComponentType<{index: number}>): Promise<RenderedTree> {
    const tree = render(buildProbeList(count, Probe));
    await actAsync(() => {});

    return tree;
}

/** Unmounts a tree and lets effect cleanups (and their Onyx disconnects) finish before returning. */
async function unmountTree(tree: RenderedTree): Promise<void> {
    tree.unmount();
    await actAsync(() => {});
}

export {actAsync, buildProbeList, renderProbes, unmountTree};
export type {RenderedTree};
