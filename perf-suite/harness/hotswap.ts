import {getActiveArm, getArmNames, setActiveArm} from './hotswap/runtime';

/** True when jest.config.js wired both arms into this process (ab.sh --hotswap). */
function isHotswapRun(): boolean {
    return Boolean(process.env.ONYX_PERF_HOTSWAP_ARMS);
}

/** How many consecutive blocks an interleaved measurement is split into; each block is written as a round. */
function getHotswapBlockCount(): number {
    const blocks = Number(process.env.ONYX_PERF_HOTSWAP_ROUNDS ?? '');

    return Number.isInteger(blocks) && blocks > 0 ? blocks : 4;
}

export {getActiveArm, getArmNames, getHotswapBlockCount, isHotswapRun, setActiveArm};
