import {
    getMediaPrimaryKey,
    getQualityOrder,
    isSameMedia,
    setInternalData,
} from "@/common/media-util";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DownloadState, localPluginName } from "@/common/constant";
import PQueue from "p-queue";
import {
    addDownloadedMusicToList,
    isDownloaded,
    removeDownloadedMusic,
    setupDownloadedMusicList,
    useDownloaded,
    useDownloadedMusicList,
} from "./downloaded-sheet";
import { getGlobalContext } from "@shared/global-context/renderer";
import Store from "@/common/store";
import { useEffect, useState } from "react";
import { DownloadEvts, ee } from "./ee";
import AppConfig from "@shared/app-config/renderer";
import PluginManager from "@shared/plugin-manager/renderer";


export interface IDownloadStatus {
    state: DownloadState;
    downloaded?: number;
    total?: number;
    msg?: string;
}

const downloadingMusicStore = new Store<Array<IMusic.IMusicItem>>([]);
const downloadingProgress = new Map<string, IDownloadStatus>();

type IOnStateChangeFunc = (data: IDownloadStatus) => void;

async function setupDownloader() {
    setupDownloaderWorker();
    setupDownloadedMusicList();
}

function setupDownloaderWorker() {
    setDownloadingConcurrency(AppConfig.getConfig("download.concurrency"));
}

const concurrencyLimit = 20;
const downloadingQueue = new PQueue({
    concurrency: 5,
});

function setDownloadingConcurrency(concurrency: number) {
    if (isNaN(concurrency)) {
        return;
    }
    downloadingQueue.concurrency = Math.min(
        concurrency < 1 ? 1 : concurrency,
        concurrencyLimit,
    );
}

async function startDownload(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
) {
    setupDownloaderWorker();

    const _musicItems = Array.isArray(musicItems) ? musicItems : [musicItems];
    // 过滤掉已下载的、本地音乐、任务中的音乐
    const _validMusicItems = _musicItems.filter(
        (it) => !isDownloaded(it) && it.platform !== localPluginName,
    );

    const downloadCallbacks = _validMusicItems.map((it) => {
        const pk = getMediaPrimaryKey(it);
        downloadingProgress.set(pk, {
            state: DownloadState.WAITING,
        });

        return async () => {
            // Not on waiting list
            if (!downloadingProgress.has(pk)) {
                return;
            }

            downloadingProgress.get(pk).state = DownloadState.DOWNLOADING;
            const fileName = `${it.title}-${it.artist}`.replace(/[/|\\?*"<>:]/g, "_");
            await new Promise<void>((resolve) => {
                downloadMusicImpl(it, fileName, (stateData) => {
                    downloadingProgress.set(pk, stateData);
                    ee.emit(DownloadEvts.DownloadStatusUpdated, it, stateData);
                    if (stateData.state === DownloadState.DONE) {
                        downloadingMusicStore.setValue((prev) =>
                            prev.filter((di) => !isSameMedia(it, di)),
                        );
                        downloadingProgress.delete(pk);
                        resolve();
                    } else if (stateData.state === DownloadState.ERROR) {
                        resolve();
                    }
                });
            });
        };
    });

    downloadingMusicStore.setValue((prev) => [...prev, ..._validMusicItems]);
    downloadingQueue.addAll(downloadCallbacks);
}

async function downloadMusicImpl(
    musicItem: IMusic.IMusicItem,
    fileName: string,
    onStateChange: IOnStateChangeFunc,
) {
    const [defaultQuality, whenQualityMissing] = [
        AppConfig.getConfig("download.defaultQuality"),
        AppConfig.getConfig("download.whenQualityMissing"),
    ];
    const qualityOrder = getQualityOrder(defaultQuality, whenQualityMissing);
    let mediaSource: IPlugin.IMediaSourceResult | null = null;
    let realQuality: IMusic.IQualityKey = qualityOrder[0];
    for (const quality of qualityOrder) {
        try {
            mediaSource = await PluginManager.callPluginDelegateMethod(
                musicItem,
                "getMediaSource",
                musicItem,
                quality,
            );
            if (!mediaSource?.url) {
                continue;
            }
            realQuality = quality;
            break;
        } catch {}
    }

    try {
        if (mediaSource?.url) {
            const ext = mediaSource.url.match(/.*\/.+\.([^./?#]+)/)?.[1] ?? "mp3";
            const downloadBasePath =
        AppConfig.getConfig("download.path") ??
        getGlobalContext().appPath.downloads;
            const downloadPath = window.path.resolve(
                downloadBasePath,
                `./${fileName}.${ext}`,
            );
            // Tauri 迁移（阶段4）：Rust download_file command + 进度事件（并发由本模块 PQueue 控制）
            await new Promise<void>((resolve) => {
                let unListen: (() => void) | null = null;
                let settled = false;
                const finish = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    unListen?.();
                    resolve();
                };
                listen<{
                    filePath: string;
                    state: "downloading" | "done" | "error";
                    currentSize?: number;
                    totalSize?: number;
                    msg?: string;
                }>("download-progress", (evt) => {
                    if (evt.payload?.filePath !== downloadPath) {
                        return;
                    }
                    const dataState = evt.payload.state === "done"
                        ? { state: DownloadState.DONE }
                        : evt.payload.state === "error"
                            ? { state: DownloadState.ERROR, msg: evt.payload.msg }
                            : {
                                state: DownloadState.DOWNLOADING,
                                downloaded: evt.payload.currentSize,
                                total: evt.payload.totalSize,
                            };
                    onStateChange(dataState as any);
                    if (dataState.state === DownloadState.DONE) {
                        addDownloadedMusicToList(
                            setInternalData<IMusic.IMusicItemInternalData>(
                                musicItem as any,
                                "downloadData",
                                {
                                    path: downloadPath,
                                    quality: realQuality,
                                },
                                true,
                            ) as IMusic.IMusicItem,
                        );
                        finish();
                    } else if (dataState.state === DownloadState.ERROR) {
                        finish();
                    }
                }).then((un) => {
                    if (settled) {
                        un();
                    } else {
                        unListen = un;
                    }
                });
                invoke("download_file", { source: mediaSource, filePath: downloadPath }).catch(() => {
                    // Rust 侧失败也会通过事件回报错误；此处兜底解除挂起
                    onStateChange({ state: DownloadState.ERROR, msg: "download invoke failed" });
                    finish();
                });
            });
        } else {
            throw new Error("Invalid Source");
        }
    } catch (e) {
        console.log(e, "ERROR");
        onStateChange({
            state: DownloadState.ERROR,
            msg: e?.message,
        });
    }
}

function useDownloadStatus(musicItem: IMusic.IMusicItem) {
    const [downloadStatus, setDownloadStatus] = useState<IDownloadStatus | null>(
        null,
    );

    useEffect(() => {
        setDownloadStatus(
            downloadingProgress.get(getMediaPrimaryKey(musicItem)) || null,
        );

        const updateFn = (mi: IMusic.IMusicItem, stateData: IDownloadStatus) => {
            if (isSameMedia(mi, musicItem)) {
                setDownloadStatus(stateData);
            }
        };

        ee.on(DownloadEvts.DownloadStatusUpdated, updateFn);

        return () => {
            ee.off(DownloadEvts.DownloadStatusUpdated, updateFn);
        };
    }, [musicItem]);

    return downloadStatus;
}

// 下载状态
function useDownloadState(musicItem: IMusic.IMusicItem) {
    const musicStatus = useDownloadStatus(musicItem);
    const downloaded = useDownloaded(musicItem);

    return (
        musicStatus?.state || (downloaded ? DownloadState.DONE : DownloadState.NONE)
    );
}

const Downloader = {
    setupDownloader,
    startDownload,
    useDownloadStatus,
    useDownloadingMusicList: downloadingMusicStore.useValue,
    useDownloaded,
    isDownloaded,
    useDownloadedMusicList,
    removeDownloadedMusic,
    setDownloadingConcurrency,
    useDownloadState,
};
export default Downloader;
