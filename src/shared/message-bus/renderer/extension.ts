import { IAppState, ICommand } from "@shared/message-bus/type";
import { useEffect, useState } from "react";
import EventEmitter from "eventemitter3";
import { emitTo, listen } from "@tauri-apps/api/event";

/**
 * Tauri 版 message-bus 扩展窗口侧（lrc/minimode，阶段1）
 * 原实现经 MessagePort 与主窗口直连；现：
 * - 状态：listen "app-state-changed"（Rust 从主窗口 sync_app_state 转发而来），
 *   按本窗口 subscribeAppState 声明的 keys 过滤
 * - 命令：emitTo("main", "renderer-command")
 */
let appState: IAppState = {};
let subscribedKeys: (keyof IAppState)[] = [];
const ee = new EventEmitter<{
    stateChanged: [IAppState, IAppState];
}>();

let sourceReady = false;
async function ensureSource() {
    if (sourceReady) return;
    sourceReady = true;
    await listen<Partial<IAppState>>("app-state-changed", (evt) => {
        const patch = evt.payload || {};
        const filtered: IAppState = {};
        for (const key of subscribedKeys) {
            if (key in patch) {
                // @ts-ignore 动态 key 赋值
                filtered[key] = patch[key];
            }
        }
        if (Object.keys(filtered).length) {
            appState = { ...appState, ...filtered };
            ee.emit("stateChanged", appState, filtered);
        }
    });
}

interface IWindowCommand {
    command: keyof ICommand;
    data?: any;
}

const mod = {
    sendCommand<T extends keyof ICommand>(command: T, data?: ICommand[T]) {
        emitTo("main", "renderer-command", {
            command,
            data,
        } satisfies IWindowCommand).catch(() => {
            /* 主窗口未就绪时命令丢失，同原版未连接时缓存语义的简化 */
        });
    },
    async subscribeAppState(keys: (keyof IAppState)[]) {
        subscribedKeys = keys;
        await ensureSource();
        // 重新订阅后请求一次全量同步（对齐原版 mount 后 SyncAppState 流程）
        emitTo("main", "renderer-command", {
            command: "SyncAppState",
        } satisfies IWindowCommand).catch(() => {});
    },
    getAppState(): IAppState {
        return appState;
    },
    onStateChange(cb: (appState: IAppState, changedAppState: IAppState) => void) {
        ensureSource();
        ee.on("stateChanged", cb);
    },
    offStateChange(cb: (appState: IAppState, changedAppState: IAppState) => void) {
        ee.off("stateChanged", cb);
    },
};

export function useAppState() {
    const [appState, setAppState] = useState(mod.getAppState);

    useEffect(() => {
        mod.onStateChange(setAppState);
        setAppState(mod.getAppState);
        return () => {
            mod.offStateChange(setAppState);
        };
    }, []);

    return appState;
}

export function useAppStatePartial<K extends keyof IAppState>(key: K) {
    const [appState, setAppState] = useState<IAppState[K]>(
        mod.getAppState()?.[key],
    );
    useEffect(() => {
        const cb = (appState: IAppState, changedAppState: IAppState) => {
            if (key in changedAppState) {
                setAppState(mod.getAppState()[key]);
            }
        };

        mod.onStateChange(cb);
        setAppState(mod.getAppState()?.[key]);
        return () => {
            mod.offStateChange(cb);
        };
    }, []);

    return appState;
}

const messageBus = {
    sendCommand: mod.sendCommand,
    subscribeAppState: mod.subscribeAppState,
    onStateChange: mod.onStateChange,
    offStateChange: mod.offStateChange,
};

export default messageBus;
