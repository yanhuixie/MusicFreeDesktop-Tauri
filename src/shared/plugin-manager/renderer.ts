import Store from "@/common/store";
import AppConfig from "@shared/app-config/renderer";
import useAppConfig from "@/hooks/useAppConfig";
import { useMemo } from "react";
import * as pluginBridge from "./renderer/plugin-bridge";

/**
 * Tauri 版 plugin-manager renderer（阶段3）
 * 原实现经 window["@shared/plugin-manager"]（主进程 IPC）；
 * 现接 plugin-bridge（iframe 运行时 + plugin-fs 文件管理 + Rust http 代理），
 * 导出签名与查询工具函数保持不变。
 */

const delegatePluginsStore = new Store<IPlugin.IPluginDelegate[]>([]);

pluginBridge.onPluginUpdated((plugins) => {
    delegatePluginsStore.setValue(plugins);
});

function getSupportedPlugin(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
) {
    return delegatePluginsStore
        .getValue()
        .filter((_) => _.supportedMethod.includes(featureMethod));
}

function getSortedSupportedPlugin(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
) {
    const meta = AppConfig.getConfig("private.pluginMeta") ?? {};
    return delegatePluginsStore
        .getValue()
        .filter((_) => _.supportedMethod.includes(featureMethod))
        .sort((a, b) => {
            return (meta[a.platform]?.order ?? Infinity) -
                (meta[b?.platform]?.order ?? Infinity) <
                0
                ? -1
                : 1;
        });
}

function getSearchablePlugins(
    supportedSearchType?: IMedia.SupportMediaType,
) {
    return getSupportedPlugin("search").filter((_) =>
        supportedSearchType && _.supportedSearchType
            ? _.supportedSearchType.includes(supportedSearchType)
            : true,
    );
}


function getSortedSearchablePlugins(
    supportedSearchType?: IMedia.SupportMediaType,
) {
    return getSortedSupportedPlugin("search").filter((_) =>
        supportedSearchType && _.supportedSearchType
            ? _.supportedSearchType.includes(supportedSearchType)
            : true,
    );
}

function getPluginByHash(hash: string) {
    return delegatePluginsStore.getValue().find((item) => item.hash === hash);
}

function getPluginByPlatform(platform: string) {
    return delegatePluginsStore.getValue().find((item) => item.platform === platform);
}

function isSupportFeatureMethod(platform: string, featureMethod: keyof IPlugin.IPluginInstanceMethods) {
    if (!platform) {
        return false;
    }
    return delegatePluginsStore.getValue().find((item) => item.platform === platform)?.supportedMethod?.includes?.(featureMethod) ?? false;
}


function getPluginPrimaryKey(pluginItem: { platform?: string }) {
    return (
        delegatePluginsStore
            .getValue()
            .find((it) => it.platform === pluginItem.platform)?.primaryKey ?? []
    );
}


async function setup() {
    await pluginBridge.loadAllPlugins();
}

const PluginManager = {
    setup,
    getSortedSupportedPlugin,
    getSupportedPlugin,
    getSearchablePlugins,
    getSortedSearchablePlugins,
    getPluginByHash,
    getPluginByPlatform,
    isSupportFeatureMethod,
    getPluginPrimaryKey,
    callPluginDelegateMethod<T extends keyof IPlugin.IPluginInstanceMethods>(
        pluginDelegate: { hash?: string; platform?: string },
        method: T,
        ...args: Parameters<IPlugin.IPluginInstanceMethods[T]>
    ): ReturnType<IPlugin.IPluginInstanceMethods[T]> {
        return pluginBridge.callPluginMethod(pluginDelegate, method as string, ...(args as any[])) as any;
    },
    updateAllPlugins: pluginBridge.updateAllPlugins,
    uninstallPlugin: pluginBridge.uninstallPlugin,
    installPluginFromRemote: pluginBridge.installPluginFromRemote,
    installPluginFromLocal: pluginBridge.installPluginFromLocal,
};

export default PluginManager;

export function useSupportedPlugin(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
) {
    return delegatePluginsStore
        .useValue()
        .filter((_) => _.supportedMethod.includes(featureMethod));
}

export function useSortedSupportedPlugin(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
) {
    const meta = AppConfig.getConfig("private.pluginMeta") ?? {};
    return delegatePluginsStore
        .useValue()
        .filter((_) => _.supportedMethod.includes(featureMethod))
        .sort((a, b) => {
            return (meta[a.platform]?.order ?? Infinity) -
                (meta[b?.platform]?.order ?? Infinity) <
                0
                ? -1
                : 1;
        });
}

export function useSortedPlugins() {
    const plugins = delegatePluginsStore.useValue();
    const meta = useAppConfig("private.pluginMeta") ?? {};

    return useMemo(() => {
        return [...plugins].sort((a, b) => {
            return (meta[a.platform]?.order ?? Infinity) -
                (meta[b?.platform]?.order ?? Infinity) <
                0
                ? -1
                : 1;
        });
    }, [plugins, meta]);
}
