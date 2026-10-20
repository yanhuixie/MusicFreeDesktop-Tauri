import type { IGlobalContext } from "./type";
import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri 版 global-context renderer（阶段1）
 * 原实现为 ipcRenderer.sendSync 同步获取；Tauri 无同步 IPC，
 * 改为启动时 setupGlobalContext()（入口调用，bootstrap 之前）拉取并缓存，
 * getGlobalContext() 保持同步签名，调用点零改动。
 * workersPath 保留字段但恒为空串（Node worker 已移除，阶段4 Rust 化）。
 */
let cachedContext: IGlobalContext | null = null;

export async function setupGlobalContext() {
    cachedContext = await invoke<IGlobalContext>("get_global_context");
    return cachedContext;
}

export const getGlobalContext = (): IGlobalContext => {
    if (!cachedContext) {
        throw new Error("getGlobalContext called before setupGlobalContext");
    }
    return cachedContext;
};
