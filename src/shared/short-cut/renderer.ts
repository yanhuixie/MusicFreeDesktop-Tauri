import AppConfig from "@shared/app-config/renderer";
import { IAppConfig } from "@/types/app-config";
import { shortCutKeys, shortCutKeysCommands } from "@/common/constant";
import hotkeys from "hotkeys-js";
import messageBus from "@shared/message-bus/renderer/main";
import { invoke } from "@tauri-apps/api/core";

type IShortCutKeys = keyof IAppConfig["shortCut.shortcuts"];

/**
 * Tauri 版 short-cut renderer（阶段5）
 * 应用内快捷键（hotkeys-js）原样保留；
 * 全局快捷键改为 invoke Rust（tauri-plugin-global-shortcut，注册时携带命令映射），
 * 配置持久化逻辑与原版一致。
 */
const mod = {
    registerGlobalShortCut(key: IShortCutKeys, shortCut: string[]) {
        if (!shortCut?.length) {
            return;
        }
        const prevConfig = AppConfig.getConfig("shortCut.shortcuts");
        const prev = prevConfig?.[key]?.global;
        if (prev?.length) {
            invoke("unregister_global_shortcut", { shortcut: prev.join("+") }).catch(() => {});
        }
        invoke("register_global_shortcut", {
            shortcut: shortCut.join("+"),
            command: shortCutKeysCommands[key],
        })
            .then((ok) => {
                const newConfig = {
                    ...(prevConfig || ({} as any)),
                    [key]: {
                        ...(prevConfig?.[key] || {}),
                        global: ok ? shortCut : null,
                    },
                };
                AppConfig.setConfig({
                    "shortCut.shortcuts": newConfig,
                });
            })
            .catch(() => {});
    },
    unregisterGlobalShortCut(key: IShortCutKeys) {
        const prevShortCut = AppConfig.getConfig("shortCut.shortcuts")?.[key]?.global;
        if (prevShortCut?.length) {
            invoke("unregister_global_shortcut", { shortcut: prevShortCut.join("+") }).catch(() => {});
            const prevConfig = AppConfig.getConfig("shortCut.shortcuts");
            AppConfig.setConfig({
                "shortCut.shortcuts": {
                    ...(prevConfig || ({} as any)),
                    [key]: {
                        ...(prevConfig?.[key] || {}),
                        global: null,
                    },
                },
            });
        }
    },
};

const originalHotkeysFilter = hotkeys.filter;

hotkeys.filter = (event) => {
    const target = event.target as HTMLElement;
    if (target.dataset["capture"] === "true") {
        return true;
    }
    return originalHotkeysFilter(event);
};

class ShortCut {
    private localShortCutCallbackMap = new Map<string, (...args: any[]) => void>();

    setup() {
        try {
            const shortCuts = AppConfig.getConfig("shortCut.shortcuts");
            for (const shortCutKey of shortCutKeys) {
                const localShortCutConfig = shortCuts?.[shortCutKey]?.local;
                if (localShortCutConfig?.length) {
                    this.registerLocalShortCut(shortCutKey, localShortCutConfig);
                }
            }
        } catch {
            // pass
        }
    }


    registerLocalShortCut(key: IShortCutKeys, shortCut: string[]) {
        if (!shortCut?.length) {
            return;
        }
        this.unregisterLocalShortCut(key);
        const callback = (evt: KeyboardEvent) => {
            if (AppConfig.getConfig("shortCut.enableLocal")) {
                evt.preventDefault();
                messageBus.sendCommand(shortCutKeysCommands[key]);
            }
        };
        this.localShortCutCallbackMap.set(key as string, callback);
        hotkeys(shortCut.join("+"), "all", callback);

        const shortCuts = AppConfig.getConfig("shortCut.shortcuts");
        AppConfig.setConfig({
            "shortCut.shortcuts": {
                ...(shortCuts || {} as any),
                [key]: {
                    ...(shortCuts?.[key] || {}),
                    local: shortCut,
                },
            },
        });
    }

    unregisterLocalShortCut(key: IShortCutKeys) {
        const shortCuts = AppConfig.getConfig("shortCut.shortcuts");
        const prevShortCut = shortCuts?.[key]?.local;
        if (prevShortCut?.length) {
            hotkeys.unbind(prevShortCut.join("+"), "all", this.localShortCutCallbackMap.get(key as string));
            this.localShortCutCallbackMap.delete(key as string);

            AppConfig.setConfig({
                "shortCut.shortcuts": {
                    ...(shortCuts || {} as any),
                    [key]: {
                        ...(shortCuts[key] || {}),
                        local: null,
                    },
                },
            });
        }
    }

    registerGlobalShortCut(key: IShortCutKeys, shortCut: string[]) {
        mod.registerGlobalShortCut(key, shortCut);
    }

    unregisterGlobalShortCut(key: IShortCutKeys) {
        mod.unregisterGlobalShortCut(key);
    }
}


const shortCut = new ShortCut();
export default shortCut;
