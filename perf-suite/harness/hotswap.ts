import {getActiveArm, getArmNames, setActiveArm} from './hotswap/runtime';

/** True when jest.config.js wired both arms into this process (ab.sh --hotswap). */
function isHotswapRun(): boolean {
    return Boolean(process.env.ONYX_PERF_HOTSWAP_ARMS);
}

export {getActiveArm, getArmNames, isHotswapRun, setActiveArm};
