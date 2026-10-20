/**
 * Tauri 版 utils renderer（阶段1）
 * 原 preload 注入 window["@shared/utils"]（node fs / electron dialog/shell）；
 * 现改为 plugin-fs / plugin-dialog / plugin-opener + 自定义窗口 command 封装，
 * 导出 fsUtil/appUtil/appWindowUtil/shellUtil/dialogUtil 签名对齐原版。
 */
import { invoke } from "@tauri-apps/api/core";
import * as pluginFs from "@tauri-apps/plugin-fs";
import * as pluginDialog from "@tauri-apps/plugin-dialog";
import { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import * as tauriPath from "@tauri-apps/api/path";

/****** fs utils ******/
const fsUtil = {
    async writeFile(path: string, data: string | Uint8Array, _encoding?: string) {
        if (typeof data === "string") {
            await pluginFs.writeTextFile(path, data);
        } else {
            await pluginFs.writeFile(path, data);
        }
    },
    async readFile(path: string, _encoding?: string): Promise<string | Uint8Array> {
        // 渲染层现有调用均为文本（备份 JSON / 歌词 / 临时文件）
        return await pluginFs.readTextFile(path);
    },
    async isFile(path: string): Promise<boolean> {
        try {
            return (await pluginFs.stat(path)).isFile;
        } catch {
            return false;
        }
    },
    async isFolder(path: string): Promise<boolean> {
        try {
            return (await pluginFs.stat(path)).isDirectory;
        } catch {
            return false;
        }
    },
    async rimraf(path: string): Promise<boolean> {
        try {
            await pluginFs.remove(path, { recursive: true });
            return true;
        } catch {
            return false;
        }
    },
    addFileScheme(filePath: string): string {
        if (filePath.startsWith("file:")) {
            return filePath;
        }
        // url.pathToFileURL 的 web 等价实现（Windows 盘符路径）
        const normalized = filePath.replace(/\\/g, "/");
        const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
        return `file://${prefixed}`;
    },
};

/****** app utils ******/
const pathResolvers: Record<string, () => Promise<string>> = {
    home: tauriPath.homeDir,
    appData: tauriPath.appDataDir,
    userData: tauriPath.appDataDir,
    sessionData: tauriPath.appDataDir,
    temp: tauriPath.tempDir,
    desktop: tauriPath.desktopDir,
    documents: tauriPath.documentDir,
    downloads: tauriPath.downloadDir,
    music: tauriPath.audioDir,
    pictures: tauriPath.pictureDir,
    videos: tauriPath.videoDir,
    logs: () => tauriPath.appLogDir(),
};

const app = {
    exitApp() {
        invoke("exit_app");
    },
    async getPath(pathName: string): Promise<string> {
        const resolver = pathResolvers[pathName];
        if (!resolver) {
            return "";
        }
        return (await resolver()) || "";
    },
    async checkUpdate(): Promise<ICommon.IUpdateInfo | null> {
        // Rust reqwest 拉取 version.json 比对（阶段5）
        try {
            return await invoke<ICommon.IUpdateInfo>("check_update");
        } catch {
            return { version: "0.0.8" };
        }
    },
    async getCacheSize(): Promise<number> {
        // WebView2 缓存目录统计（阶段6）
        return (await invoke<number>("get_cache_size").catch(() => 0)) || 0;
    },
    clearCache() {
        invoke("clear_cache").catch(() => {});
    },
};

/****** window utils ******/
const appWindow = {
    minMainWindow(skipTaskBar?: boolean) {
        invoke("min_main_window", { skipTaskBar: !!skipTaskBar });
    },
    showMainWindow() {
        invoke("show_main_window");
    },
    setLyricWindow(enabled: boolean) {
        invoke("set_lyric_window", { enabled });
    },
    setMinimodeWindow(enabled: boolean) {
        invoke("set_minimode_window", { enabled });
    },
    async ignoreMouseEvent(ignore: boolean) {
        invoke("ignore_mouse_event", { windowLabel: "lrc", ignore });
    },
    toggleMainWindowVisible() {
        invoke("toggle_main_window_visible");
    },
    toggleMainWindowMaximize() {
        invoke("toggle_main_window_maximize");
    },
};

/****** shell utils ******/
const shell = {
    openExternal(url: string) {
        openUrl(url).catch(() => {});
    },
    openPath(path: string) {
        openPath(path).catch(() => {});
    },
    async showItemInFolder(path: string): Promise<boolean> {
        try {
            await revealItemInDir(path);
            return true;
        } catch {
            return false;
        }
    },
};

/****** dialog utils ******/
/** Electron.OpenDialogOptions → plugin-dialog 选项适配 */
function toDialogOptions(options: any): pluginDialog.OpenDialogOptions {
    const properties: string[] = options?.properties || [];
    return {
        title: options?.title,
        defaultPath: options?.defaultPath,
        multiple: properties.includes("multiSelections"),
        directory: properties.includes("openDirectory"),
        filters: options?.filters,
    };
}

const dialog = {
    async showOpenDialog(options: any): Promise<{ canceled: boolean; filePaths: string[] }> {
        const result = await pluginDialog.open(toDialogOptions(options));
        if (result === null) {
            return { canceled: true, filePaths: [] };
        }
        const filePaths = Array.isArray(result) ? result : [result];
        return { canceled: false, filePaths };
    },
    async showSaveDialog(options: any): Promise<{ canceled: boolean; filePath: string }> {
        const result = await pluginDialog.save({
            title: options?.title,
            defaultPath: options?.defaultPath,
            filters: options?.filters,
        });
        if (result === null) {
            return { canceled: true, filePath: "" };
        }
        return { canceled: false, filePath: result };
    },
};

const utils = {
    fs: fsUtil,
    app,
    appWindow,
    shell,
    dialog,
};

export default utils;
export { fsUtil, app as appUtil, appWindow as appWindowUtil, shell as shellUtil, dialog as dialogUtil };
