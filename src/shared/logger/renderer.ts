import { attachConsole, info, error as logErrorFn, warn } from "@tauri-apps/plugin-log";
import { safeStringify } from "@/common/safe-serialization";

/**
 * Tauri 版 logger renderer（阶段1）：electron-log → tauri-plugin-log
 */
let detachConsole: (() => void) | null = null;

async function setup() {
    if (!detachConsole) {
        detachConsole = await attachConsole();
    }
}

function logError(msg: string, error: Error, extra?: any) {
    setup();
    logErrorFn(`${msg} ${error?.name} ${error?.message} ${error?.stack ?? ""} ${safeStringify(extra)}`);
}

function logInfo(msg: string, extra?: any) {
    setup();
    info(`${msg} ${safeStringify(extra)}`);
}

function logWarn(msg: string, extra?: any) {
    setup();
    warn(`${msg} ${safeStringify(extra)}`);
}

let firstPerfLogTime = 0;
function logPerf(msg: string) {
    setup();
    const timestamp = Date.now();
    if (!firstPerfLogTime) {
        firstPerfLogTime = timestamp;
    }
    info("[Perf Renderer]: " + msg + " [Offset]: " + (timestamp - firstPerfLogTime) + "ms");
}


const logger = {
    logInfo,
    logError,
    logWarn,
    logPerf,
};

export default logger;
