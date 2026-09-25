/**
 * The suite's components go through the same React Compiler build Expensify/App gives its own code
 * (`babel.config.js` there), so a hook scenario measures `useOnyx` under compiled callers. The Onyx arms
 * are never transformed, see jest.config.js.
 */
const REACT_COMPILER_CONFIG = {
    target: '19',
    environment: {enableTreatRefLikeIdentifiersAsRefs: true},
    sources: (filename) => !filename.includes('/node_modules/'),
};

module.exports = {
    presets: [require.resolve('@react-native/babel-preset')],
    plugins: [[require.resolve('babel-plugin-react-compiler'), REACT_COMPILER_CONFIG]],
};
