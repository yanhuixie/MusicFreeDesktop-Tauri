import { IAppConfig } from "@/types/app-config";
import defaultAppConfig from "@shared/app-config/default-app-config";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Tauri 版 app-config renderer（阶段1）
 * 原实现经 preload 暴露的 window["@shared/app-config"] IPC；
 * 现直接 invoke Rust command + listen "app-config:update" 事件，导出签名不变。
 */
class AppConfig {
    private config: IAppConfig = {};

    public initialized = false;

    private updateCallbacks: Set<(patch: IAppConfig, config: IAppConfig) => void> = new Set();

    private unListen: (() => void) | null = null;

    private notifyCallbacks(patch: IAppConfig) {
        for (const callback of this.updateCallbacks) {
            callback(patch, this.config);
        }
    }

    async setup() {
        this.initialized = true;
        this.config = await invoke("sync_app_config");
        this.notifyCallbacks(this.config);
        this.unListen = await listen<IAppConfig>("app-config:update", (evt) => {
            const patch = evt.payload || {};
            this.config = { ...defaultAppConfig, ...this.config, ...patch };
            this.notifyCallbacks(patch);
        });
    }

    public onConfigUpdate(callback: (patch: IAppConfig, config: IAppConfig) => void) {
        this.updateCallbacks.add(callback);
    }

    public offConfigUpdate(callback: (patch: IAppConfig, config: IAppConfig) => void) {
        this.updateCallbacks.delete(callback);
    }

    public getAllConfig() {
        return this.config;
    }

    public getConfig<T extends keyof IAppConfig>(key: T): IAppConfig[T] {
        return this.config[key];
    }

    public setConfig(data: IAppConfig) {
        invoke("set_app_config", { patch: data });
    }

    public reset() {
        invoke("reset_app_config");
        this.config = defaultAppConfig;
        this.notifyCallbacks(this.config);
    }

}

export default new AppConfig();
