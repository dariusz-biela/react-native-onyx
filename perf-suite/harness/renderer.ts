import type {ReactElement} from 'react';
import type {ReactTestRenderer} from 'react-test-renderer';

import {act} from 'react';
import {create} from 'react-test-renderer';

/**
 * The part of `@testing-library/react-native` 13 that Expensify/App's hook tests go through: `render` creates a
 * concurrent-root test renderer inside a synchronous `act`, and `rerender` and `unmount` wrap theirs the same way.
 * The act globals are set in `jest/setupHarness.ts`, as the App's React Native Jest preset and RTL set them.
 */
declare module 'react-test-renderer' {
    // The option exists in react-test-renderer 19 (RTL 13 passes it) but its type definitions leave it out.
    interface TestRendererOptions {
        unstable_isConcurrent?: boolean;
    }
}

type RenderedTree = {
    rerender: (element: ReactElement) => void;
    unmount: () => void;
};

function render(element: ReactElement): RenderedTree {
    let renderer: ReactTestRenderer | undefined;

    act(() => {
        renderer = create(element, {createNodeMock: () => null, unstable_isConcurrent: true});
    });

    if (!renderer) {
        throw new Error('render: the test renderer was not created inside act.');
    }

    const mounted = renderer;

    return {
        rerender: (nextElement) => {
            act(() => {
                mounted.update(nextElement);
            });
        },
        unmount: () => {
            act(() => {
                mounted.unmount();
            });
        },
    };
}

export default render;
export type {RenderedTree};
