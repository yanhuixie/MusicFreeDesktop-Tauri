import Store from "@/common/store";
import { toast } from "react-toastify";
import { useEffect } from "react";
import debounce from "@/common/debounce";
import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri 版 themepack renderer（阶段4）
 * 原实现：preload 直接用 Node fs/unzipper 读写并注入；
 * 现：Rust zip 命令（安装/卸载/列表/读文件）+ web 侧 CSS/iframe 注入（逻辑对齐原 preload），
 * Store/防抖/替换安装等上层流程与原 renderer 完全一致。
 */

// 所有本地主题包
const localThemePacksStore = new Store<Array<ICommon.IThemePack | null>>([]);
// 当前选中的主题包
const currentThemePackStore = new Store<ICommon.IThemePack | null>(null);

const themeNodeId = "themepack-node";
const themePathKey = "themepack-path";

const validIframeMap = new Map<
    "app" | "header" | "body" | "music-bar" | "side-bar" | "page",
    HTMLIFrameElement | null
>([
    ["app", null],
    ["header", null],
    ["body", null],
    ["music-bar", null],
    ["side-bar", null],
    ["page", null],
]);

/** 替换 @/ 标记为主题目录原生路径（对齐原 preload.replaceAlias；withFileScheme 参数保留兼容） */
function replaceAlias(rawText: string, basePath: string, _withFileScheme = true): string {
    return rawText.replaceAll("@/", `${basePath.replace(/[\\/]+$/, "")}/`);
}

/** 注入主题（CSS + 可选 iframe），逻辑对齐原 preload.selectTheme */
async function applyTheme(themePack: ICommon.IThemePack | null) {
    const themeNode = document.querySelector(`#${themeNodeId}`)!;
    if (!themePack?.hash || !themePack.path) {
        // 移除
        themeNode.innerHTML = "";
        validIframeMap.forEach((value, key) => {
            if (value !== null) {
                value.remove();
                validIframeMap.set(key, null);
            }
        });
        localStorage.removeItem(themePathKey);
    } else {
        const rawStyle = await invoke<string>("theme_read_file", {
            themePackPath: themePack.path,
            relativePath: "index.css",
        });
        themeNode.innerHTML = replaceAlias(rawStyle, themePack.path);

        if (themePack.iframe) {
            validIframeMap.forEach(async (_value, key) => {
                const themePackIframeSource = (themePack.iframe as any)[key];
                if (themePackIframeSource) {
                    let iframeNode = validIframeMap.get(key);
                    if (iframeNode !== null) {
                        iframeNode.remove();
                    }
                    iframeNode = document.createElement("iframe");
                    iframeNode.scrolling = "no";
                    document.querySelector(`.${key}-container`)?.prepend?.(iframeNode);
                    validIframeMap.set(key, iframeNode);

                    if (themePackIframeSource.startsWith("http")) {
                        iframeNode.src = themePackIframeSource;
                    } else {
                        try {
                            const rawHtml = await invoke<string>("theme_read_file", {
                                themePackPath: themePack.path,
                                relativePath: themePackIframeSource.replace(/^@\//, ""),
                            });
                            iframeNode.contentWindow.document.open();
                            iframeNode.contentWindow.document.write(
                                replaceAlias(rawHtml, themePack.path),
                            );
                            iframeNode.contentWindow.document.close();
                        } catch {
                            /* 单个 iframe 失败忽略 */
                        }
                    }
                } else {
                    const existing = validIframeMap.get(key);
                    if (existing) {
                        existing.remove();
                        validIframeMap.set(key, null);
                    }
                }
            });
        } else {
            validIframeMap.forEach((value, key) => {
                if (value !== null) {
                    value.remove();
                    validIframeMap.set(key, null);
                }
            });
        }
        localStorage.setItem(themePathKey, themePack.path);
    }
}

async function selectTheme(themePack: ICommon.IThemePack | null) {
    if (!themePack?.hash) {
        themePack = null;
    }
    await applyTheme(themePack);
    currentThemePackStore.setValue(themePack);
}

async function selectThemeByHash(hash: string) {
    const targetTheme = localThemePacksStore
        .getValue()
        .find((it) => it?.hash === hash);

    if (targetTheme) {
        await applyTheme(targetTheme);
        currentThemePackStore.setValue(targetTheme);
    }
}

let themePacksLoaded = false;
async function setupThemePacks() {
    try {
        const currentThemePath = localStorage.getItem(themePathKey);
        const currentTheme = await invoke<any>("theme_init_current", {
            currentPath: currentThemePath,
        });
        // 选中主题
        await selectTheme(currentTheme);
        // 调度
        requestIdleCallback(() => {
            if (!themePacksLoaded) {
                loadThemePacks();
            }
        });

        window.onresize = debounce(() => {
            selectTheme(currentThemePackStore.getValue());
        }, 150, {
            leading: false,
            trailing: true,
        });

    } catch {
    // pass
    }
}

async function loadThemePacks() {
    themePacksLoaded = true;

    const themePacks = (await invoke<any[]>("theme_load_packs")) || [];
    localThemePacksStore.setValue(themePacks);
    return themePacks;
}

async function installThemePack(themePackPath: string) {
    const themePackConfig = await invoke<any>("theme_install", { themePackPath });
    if (themePackConfig) {
        localThemePacksStore.setValue((prev) => [...prev, themePackConfig]);
    }
    return themePackConfig;
}

/**
 *
 * @param remoteUrl 主题包地址
 * @param id 可选，如果有主题id的话会替换掉本地的资源
 * @returns
 */
async function installRemoteThemePack(remoteUrl: string, id?: string) {
    const themePackConfig = await invoke<any>("theme_install_remote", { remoteUrl });

    let oldThemeConfig: ICommon.IThemePack | null = null;
    if (id) {
        oldThemeConfig = localThemePacksStore.getValue().find((it) => it.id === id);
        if (oldThemeConfig) {
            invoke("theme_uninstall", { themePackPath: oldThemeConfig.path });
        }
    }
    if (themePackConfig) {
        localThemePacksStore.setValue((prev) =>
            [themePackConfig].concat(
                oldThemeConfig
                    ? prev.filter((it) => it.hash !== oldThemeConfig.hash)
                    : prev,
            ),
        );
    }
    return themePackConfig;
}

async function uninstallThemePack(themePack: ICommon.IThemePack) {
    try {
        await invoke("theme_uninstall", { themePackPath: themePack.path });
        localThemePacksStore.setValue((prev) =>
            prev.filter((it) => it?.path !== themePack.path),
        );
        if (currentThemePackStore.getValue()?.path === themePack.path) {
            selectTheme(null);
        }
    } catch {
        toast.error("卸载失败");
    }
}

function useLocalThemePacks() {
    const val = localThemePacksStore.useValue();

    useEffect(() => {
        if (!themePacksLoaded) {
            loadThemePacks();
        }
    }, []);

    return val;
}

const ThemePack = {
    selectTheme,
    selectThemeByHash,
    setupThemePacks,
    installThemePack,
    installRemoteThemePack,
    uninstallThemePack,
    loadThemePacks,
    useLocalThemePacks,
    useCurrentThemePack: currentThemePackStore.useValue,
    replaceAlias,
};

export default ThemePack;
