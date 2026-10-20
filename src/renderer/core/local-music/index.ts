import localMusicListStore from "./store";
import { getUserPreferenceIDB } from "@/renderer/utils/user-perference";
import musicSheetDB from "../db/music-sheet-db";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setInternalData } from "@/common/media-util";

/**
 * Tauri 版本地音乐（阶段4）
 * 原实现：chokidar webworker（Comlink）；
 * 现：Rust notify 监听（防抖 500ms，"local-music-changed" 路径事件），
 * 收到路径后前端调用 parse_local_music_item 组装 musicItem 入库。
 */

type IMusicItemWithLocalPath = IMusic.IMusicItem & { $$localPath: string };

let watcherListenerReady = false;

function isSubDir(parent: string, target: string) {
    const relative = window.path.relative(parent, target);
    return (
        relative && !relative.startsWith("..") && !window.path.isAbsolute(relative)
    );
}

async function ensureWatcherListener() {
    if (watcherListenerReady) {
        return;
    }
    watcherListenerReady = true;
    await listen<{ added: string[]; removed: string[] }>("local-music-changed", async (evt) => {
        const { added = [], removed = [] } = evt.payload || {};
        try {
            if (removed.length) {
                await musicSheetDB.transaction("rw", musicSheetDB.localMusicStore, async () => {
                    const tobeDeletedFilePaths = new Set(removed);
                    const cachedLocalMusic = localMusicListStore.getValue() as IMusicItemWithLocalPath[];
                    const tobeDeletedPrimaryKeys: any[] = [];
                    const newCachedLocalMusic: IMusicItemWithLocalPath[] = [];
                    cachedLocalMusic.forEach((it) => {
                        if (tobeDeletedFilePaths.has(it.$$localPath)) {
                            tobeDeletedPrimaryKeys.push([it.platform, it.id]);
                        } else {
                            newCachedLocalMusic.push(it);
                        }
                    });
                    await musicSheetDB.localMusicStore.bulkDelete(tobeDeletedPrimaryKeys);
                    localMusicListStore.setValue(newCachedLocalMusic);
                });
            }
            if (added.length) {
                const musicItems: IMusicItemWithLocalPath[] = [];
                for (const filePath of added) {
                    try {
                        const item = await invoke<any>("parse_local_music_item", { path: filePath });
                        const musicItem = { ...item, $$localPath: filePath } as IMusicItemWithLocalPath;
                        setInternalData<IMusic.IMusicItemInternalData>(musicItem, "downloadData", {
                            path: filePath,
                            quality: "standard",
                        });
                        musicItems.push(musicItem);
                    } catch {
                        /* 单个解析失败忽略 */
                    }
                }
                if (musicItems.length) {
                    await musicSheetDB.transaction("rw", musicSheetDB.localMusicStore, async () => {
                        await musicSheetDB.localMusicStore.bulkPut(musicItems);
                        localMusicListStore.setValue(await musicSheetDB.localMusicStore.toArray());
                    });
                }
            }
        } catch {
            /* 事务失败忽略 */
        }
    });
}

async function setupLocalMusic() {
    try {
        await ensureWatcherListener();
        const localWatchDir =
            (await getUserPreferenceIDB("localWatchDirChecked")) ?? [];

        if (localWatchDir.length) {
            await invoke("watch_local_dirs", { add: localWatchDir });
        }

        const allMusic = await musicSheetDB.localMusicStore.toArray();

        localMusicListStore.setValue(allMusic);
    } catch {
    }
}

async function changeWatchPath(logs: Map<string, "add" | "delete">) {
    // 对所有的要删除的路径
    const tobeDeletedPaths: string[] = [];
    const tobeAddedPaths: string[] = [];
    logs.forEach((action, dirPath) => {
        if (action === "delete") {
            tobeDeletedPaths.push(dirPath);
        } else {
            tobeAddedPaths.push(dirPath);
        }
    });

    // 删除所有子路径的
    if (tobeDeletedPaths.length) {
        await musicSheetDB.transaction(
            "rw",
            musicSheetDB.localMusicStore,
            async () => {
                const localFiles = localMusicListStore.getValue();
                const tobeDeletedItems = localFiles
                    .filter((it) =>
                        tobeDeletedPaths.some((deletePath) =>
                            isSubDir(deletePath, (it as IMusicItemWithLocalPath).$$localPath),
                        ),
                    )
                    .map((it) => [it.platform, it.id]);
                await musicSheetDB.localMusicStore.bulkDelete(tobeDeletedItems);
            },
        );

        localMusicListStore.setValue(await musicSheetDB.localMusicStore.toArray());
    }
    // 通知 Rust 侧 watcher
    await invoke("watch_local_dirs", {
        add: tobeAddedPaths.length ? tobeAddedPaths : undefined,
        remove: tobeDeletedPaths.length ? tobeDeletedPaths : undefined,
    }).catch(() => {});
}

export default {
    setupLocalMusic,
    changeWatchPath,
};
