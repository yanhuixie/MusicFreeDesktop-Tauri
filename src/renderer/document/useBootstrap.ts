import { useEffect, useLayoutEffect } from "react";
import { useNavigate } from "react-router-dom";
import checkUpdate from "../utils/check-update";
import Themepack from "@/shared/themepack/renderer";
import logger from "@shared/logger/renderer";
import AppConfig from "@shared/app-config/renderer";
import messageBus from "@shared/message-bus/renderer/main";
import PluginManager from "@shared/plugin-manager/renderer";
import trackPlayer from "../core/track-player";

/** 插件自动更新（原 bootstrap 末尾逻辑；必须在插件表加载完成后执行） */
function maybeAutoUpdatePlugins() {
    if (!AppConfig.getConfig("plugin.autoUpdatePlugin")) {
        return;
    }
    const lastUpdated = +(localStorage.getItem("pluginLastupdatedTime") || 0);
    const now = Date.now();
    if (Math.abs(now - lastUpdated) > 86400000) {
        localStorage.setItem("pluginLastupdatedTime", `${now}`);
        void PluginManager.updateAllPlugins().catch(() => {});
    }
}

export default function useBootstrap() {
    const navigate = useNavigate();

    useLayoutEffect(() => {
        Themepack.setupThemePacks();
    }, []);

    useEffect(() => {
        messageBus.onCommand("Navigate", (route) => {
            navigate(route);
        });

        if (AppConfig.getConfig("normal.checkUpdate")) {
            checkUpdate();
        }
        logger.logPerf("Bundle First Screen");
        // 插件加载放在首屏渲染之后：读文件/哈希/iframe 执行不能阻塞首帧，
        // 完成后经 pluginUpdated 通知刷新 UI（直接读插件表的视图已改为订阅式）
        void PluginManager.setup()
            .then(async () => {
                // 首屏前 trackPlayer 取不到远程音源/歌词，插件就绪后先补取
                await trackPlayer.restoreCurrentMusicIfNeeded();
                maybeAutoUpdatePlugins();
            })
            .catch((e) => logger.logError("插件加载失败", e));
    }, []);
}
