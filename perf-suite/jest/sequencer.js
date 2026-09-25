const Sequencer = require('@jest/test-sequencer').default;

/**
 * Jest's default sequencer orders files by cached timing, so the order changes once a run has been
 * measured. Under `--runInBand` every file shares one heap, and a reordered file set moved an A/A
 * delta by up to 20%. This orders by path, which is stable across runs and across arms.
 */
class AlphabeticalSequencer extends Sequencer {
    sort(tests) {
        return [...tests].sort((a, b) => a.path.localeCompare(b.path));
    }
}

module.exports = AlphabeticalSequencer;
