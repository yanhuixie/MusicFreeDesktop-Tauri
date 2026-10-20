import { IAppState, ICommand } from "@shared/message-bus/type";
import EventEmitter from "eventemitter3";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Tauri 版 message-bus 主窗口侧（阶段1）
 * 原实现经 MessagePort 直连 + 主进程中转；现：
 * - sendCommand：本地回环（窗口内 UI 互调，同原版语义）
 * - onCommand：本地回环 + listen "window-command"（Rust 侧：托盘等，阶段5）
 *   + listen "renderer-command"（扩展窗口 emitTo 过来的命令）
 * - syncAppState：invoke "sync_app_state"（Rust 存储 + 定向转发到扩展窗口）
 */

const commandEE = new EventEmitter();

interface IWindowCommand {
    command: keyof ICommand;
    data?: any;
}

export const messageBus = {
    async onCommand<K extends keyof ICommand>(
        command: K,
        cb: (data: ICommand[K], from: "main" | number) => void,
    ) {
        // 全局事件源只需挂一次
        if (!commandEE.listenerCount("__sources_ready")) {
            commandEE.emit("__sources_ready");
            const unListenRust = await listen<IWindowCommand>("window-command", (evt) => {
                commandEE.emit("command", evt.payload, -1);
            });
            const unListenExt = await listen<IWindowCommand>("renderer-command", (evt) => {
                commandEE.emit("command", evt.payload, -1);
            });
            commandEE.once("__dispose", () => {
                unListenRust();
                unListenExt();
            });
        }
        commandEE.on("command", (payload: IWindowCommand, from: "main" | number) => {
            if (payload?.command === command) {
                cb(payload.data, from);
            }
        });
    },

    sendCommand<K extends keyof ICommand>(command: K, data?: ICommand[K]) {
        commandEE.emit("command", { command, data }, -1);
    },

    syncAppState(appState: IAppState, _to?: "main" | number) {
        invoke("sync_app_state", { patch: appState }).catch(() => {
            /* 主窗口外的窗口不会调用 */
        });
    },
};

export default messageBus;
