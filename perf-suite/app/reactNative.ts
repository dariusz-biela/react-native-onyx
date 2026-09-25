/**
 * Stands in for `react-native` in the suite: `View` and `Text` render as host components, the way
 * react-test-renderer sees them under the App's Jest preset. The package's own Jest mocks are not an option,
 * because they would load the root's React 18 next to the suite's React 19.
 */
import type {ReactNode} from 'react';

import {createElement} from 'react';

type HostProps = {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
};

function View(props: HostProps) {
    return createElement('View', props);
}

function Text(props: HostProps) {
    return createElement('Text', props);
}

export {Text, View};
