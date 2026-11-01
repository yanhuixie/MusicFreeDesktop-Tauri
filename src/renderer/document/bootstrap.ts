import { localPluginHash, PlayerState, RepeatMode, supportLocalMediaType } from "@/common/constant";
import MusicSheet from "../core/music-sheet";
import trackPlayer from "../core/track-player";
import localMusic from "../core/local-music";
import { setAutoFreeze } from "immer";
import Downloader from "../core/downloader";
import AppConfig from "@shared/app-config/renderer";
import { setupI18n } from "@/shared/i18n/renderer";
import ThemePack from "@/shared/themepack/renderer";
import { addToRecentlyPlaylist, setupRecentlyPlaylist } from "../core/recently-playlist";
import ServiceManager from "@shared/service-manager/renderer";
import { CurrentTime, PlayerEvents } from "@renderer/core/track-player/enum";
import { appWindowUtil, fsUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import messageBus from "@shared/message-bus/renderer/main";
import throttle from "lodash.throttle";
import { IAppState } from "@shared/message-bus/type";
import MusicDetail from "@renderer/components/MusicDetail";
import shortCut from "@shared/short-cut/renderer";


setAutoFreeze(false);

export default async function () {
    await AppConfig.setup();
    await Promise.all([
        MusicSheet.frontend.setupMusicSheets(),
        trackPlayer.setup(),
    ]);
    await setupI18n();
    setupTrayTexts();
    setupDeepLinkListener();
    shortCut.setup();
    dropHandler();
    clearDefaultBehavior();
    setupCommandAndEvents();
    setupDeviceChange();
    localMusic.setupLocalMusic();
    await Downloader.setupDownloader();
    setupRecentlyPlaylist();
    // 本地服务
    ServiceManager.setup();
}

function dropHandler() {
    document.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener("drop", (e) => {
        // 阻止浏览器默认打开文件行为（实际路径处理走 Tauri 拖放事件）
        e.preventDefault();
        e.stopPropagation();
    });

    // Tauri 迁移（阶段4）：File.path → onDragDropEvent 原生路径
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
        getCurrentWebview().onDragDropEvent((event) => {
            if (event.payload.type !== "drop") {
                return;
            }
            handleDroppedPaths(event.payload.paths);
        });
    });
}

async function handleDroppedPaths(paths: string[]) {
    const validMusicList: IMusic.IMusicItem[] = [];
    for (const path of paths) {
        try {
            if (await fsUtil.isFolder(path)) {
                validMusicList.push(
                    ...(await PluginManager.callPluginDelegateMethod(
                        {
                            hash: localPluginHash,
                        },
                        "importMusicSheet",
                        path,
                    )),
                );
            } else if (supportLocalMediaType.some((postfix) => path.endsWith(postfix))) {
                validMusicList.push(
                    await PluginManager.callPluginDelegateMethod(
                        {
                            hash: localPluginHash,
                        },
                        "importMusicItem",
                        path,
                    ),
                );
            } else if (path.endsWith(".mftheme")) {
                // 主题包
                const themeConfig = await ThemePack.installThemePack(path);
                if (themeConfig) {
                    await ThemePack.selectTheme(themeConfig);
                }
            }
        } catch {
            /* 单个失败忽略 */
        }
    }
    if (validMusicList.length) {
        trackPlayer.playMusicWithReplaceQueue(validMusicList);
    }
}

function clearDefaultBehavior() {
    const killSpaceBar = function (evt: any) {
        // https://greasyfork.org/en/scripts/25035-disable-space-bar-scrolling/code
        const target = evt.target || {},
            isInput =
                "INPUT" == target.tagName ||
                "TEXTAREA" == target.tagName ||
                "SELECT" == target.tagName ||
                "EMBED" == target.tagName;

        // if we're an input or not a real target exit
        if (isInput || !target.tagName) return;

        // if we're a fake input like the comments exit
        if (
            target &&
            target.getAttribute &&
            target.getAttribute("role") === "textbox"
        )
            return;

        // ignore the space
        if (evt.keyCode === 32) {
            evt.preventDefault();
        }
    };

    document.addEventListener("keydown", killSpaceBar, false);

    // Tauri 迁移：WebView2 默认右键菜单全开（Electron 引擎本身不弹，见 wry default_context_menus），
    // 此处全局禁用；文本类可编辑元素放行以保留原生复制/粘贴菜单，对齐 Electron 行为。
    // 用捕获阶段保证先于任何 stopPropagation 执行，且不影响 React onContextMenu 自绘菜单。
    document.addEventListener(
        "contextmenu",
        (evt) => {
            if (!isEditableTarget(evt.target)) {
                evt.preventDefault();
            }
        },
        true,
    );
}

/** 文本输入类元素（原生编辑菜单仍可用） */
function isEditableTarget(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (!node?.tagName) return false;
    if (node.isContentEditable || node.tagName === "TEXTAREA") return true;
    if (node.tagName === "INPUT") {
        const type = (node as HTMLInputElement).type || "text";
        return ["text", "search", "password", "email", "url", "tel", "number"].includes(type);
    }
    return false;
}


/** 设置事件 */
function setupCommandAndEvents() {
    messageBus.onCommand("SkipToNext", () => {
        trackPlayer.skipToNext();
    });
    messageBus.onCommand("SkipToPrevious", () => {
        trackPlayer.skipToPrev();
    });
    messageBus.onCommand("TogglePlayerState", () => {
        if (trackPlayer.playerState === PlayerState.Playing) {
            trackPlayer.pause();
        } else {
            trackPlayer.resume();
        }
    });
    messageBus.onCommand("SetRepeatMode", (mode) => {
        trackPlayer.setRepeatMode(mode);
    });
    messageBus.onCommand("VolumeUp", (val = 0.04) => {
        trackPlayer.setVolume(Math.min(1, trackPlayer.volume + val));
    });

    messageBus.onCommand("VolumeDown", (val = 0.04) => {
        trackPlayer.setVolume(Math.max(0, trackPlayer.volume - val));
    });

    messageBus.onCommand("ToggleFavorite", async (item) => {
        const realItem = item || trackPlayer.currentMusic;
        if (MusicSheet.frontend.isFavoriteMusic(realItem)) {
            MusicSheet.frontend.removeMusicFromFavorite(realItem);
        } else {
            MusicSheet.frontend.addMusicToFavorite(realItem);
        }
    });

    messageBus.onCommand("ToggleDesktopLyric", () => {
        const enableDesktopLyric = AppConfig.getConfig("lyric.enableDesktopLyric");
        appWindowUtil.setLyricWindow(!enableDesktopLyric);
        AppConfig.setConfig({
            "lyric.enableDesktopLyric": !enableDesktopLyric,
        });
    });

    messageBus.onCommand("OpenMusicDetailPage", () => {
        MusicDetail.show();
    });

    messageBus.onCommand("ToggleMainWindowVisible", () => {
        appWindowUtil.toggleMainWindowVisible();
    });


    const sendAppStateTo = (from: "main" | number) => {
        const appState: IAppState = {
            repeatMode: trackPlayer.repeatMode || RepeatMode.Queue,
            playerState: trackPlayer.playerState || PlayerState.None,
            musicItem: trackPlayer.currentMusicBasicInfo || null,
            lyricText: trackPlayer.lyric?.currentLrc?.lrc || null,
            parsedLrc: trackPlayer.lyric?.currentLrc || null,
            fullLyric: trackPlayer.lyric?.parser?.getLyricItems() || [],
            progress: trackPlayer.progress?.currentTime || 0,
            duration: trackPlayer.progress?.duration || 0,
        };

        messageBus.syncAppState(appState, from);
    };

    messageBus.onCommand("SyncAppState", (_, from) => {
        sendAppStateTo(from);
    });
    sendAppStateTo("main");

    // 状态同步
    trackPlayer.on(PlayerEvents.StateChanged, state => {
        messageBus.syncAppState({
            playerState: state,
        });
    });

    trackPlayer.on(PlayerEvents.RepeatModeChanged, mode => {
        messageBus.syncAppState({
            repeatMode: mode,
        });
    });

    trackPlayer.on(PlayerEvents.CurrentLyricChanged, lyric => {
        messageBus.syncAppState({
            lyricText: lyric.lrc,
            parsedLrc: lyric,
        });
    });

    trackPlayer.on(PlayerEvents.LyricChanged, lyric => {
        messageBus.syncAppState({
            fullLyric: lyric?.getLyricItems?.() || [],
        });
    });

    const progressChangedHandler = throttle((currentTime: CurrentTime) => {
        messageBus.syncAppState({
            progress: currentTime?.currentTime || 0,
            duration: currentTime.duration || 0,
        });
    }, 800);

    trackPlayer.on(PlayerEvents.ProgressChanged, progressChangedHandler);

    // 最近播放
    trackPlayer.on(PlayerEvents.MusicChanged, (musicItem) => {
        messageBus.syncAppState({
            musicItem,
            lyricText: null,
            fullLyric: [],
            parsedLrc: null,
            progress: 0,
            duration: 0,
        });
        addToRecentlyPlaylist(musicItem);
    });
}

async function setupDeviceChange() {
    const getAudioDevices = async () =>
        await navigator.mediaDevices.enumerateDevices().catch(() => []);
    let devices = (await getAudioDevices()) || [];

    navigator.mediaDevices.ondevicechange = async (evt) => {
        const newDevices = await getAudioDevices();
        if (
            newDevices.length < devices.length &&
            AppConfig.getConfig("playMusic.whenDeviceRemoved") === "pause"
        ) {
            trackPlayer.pause();
        }
        devices = newDevices;
    };
}

/** 托盘文案推送（阶段5：i18n 在前端，Rust 托盘经 command 取文案） */
const trayTextKeys = [
    "media.unknown_title",
    "main.no_playing_music",
    "media.music_state_pause",
    "media.music_state_play",
    "media.music_state_play_or_pause",
    "main.previous_music",
    "main.next_music",
    "media.music_repeat_mode",
    "media.music_repeat_mode_loop",
    "media.music_repeat_mode_queue",
    "media.music_repeat_mode_shuffle",
    "app_header.settings",
    "common.exit",
    "media.media_platform",
];

function setupTrayTexts() {
    const push = () => {
        import("@tauri-apps/api/core").then(({ invoke }) => {
            import("@/shared/i18n/renderer").then(({ i18n }) => {
                const texts: Record<string, string> = {};
                for (const key of trayTextKeys) {
                    texts[key] = i18n.t(key);
                }
                invoke("tray_update_texts", { texts }).catch(() => {});
            });
        });
    };
    push();
    // 语言变化重推
    AppConfig.onConfigUpdate((patch) => {
        if ("normal.language" in patch) {
            push();
        }
    });
}

/** 深链监听（阶段5：Rust 转发 musicfree:// → 前端复用原解析逻辑安装插件） */
function setupDeepLinkListener() {
    import("@tauri-apps/api/event").then(({ listen }) => {
        listen<string>("deep-link", (evt) => {
            const url = evt.payload;
            try {
                const urlObj = new URL(url);
                if (urlObj.protocol === "musicfree:" && urlObj.hostname === "install") {
                    const pluginUrlStr =
                        urlObj.pathname.slice(1) || urlObj.searchParams.get("plugin");
                    const pluginUrls = (pluginUrlStr || "").split(",").map(decodeURIComponent);
                    pluginUrls.forEach((it) => {
                        PluginManager.installPluginFromRemote(it).catch(() => {});
                    });
                }
            } catch {
                // pass
            }
        });
    });
}
