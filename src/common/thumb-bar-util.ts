/**
 * Thumb Bar Util
 */

import { BrowserWindow, nativeImage } from "electron";
import getResourcePath from "@/common/get-resource-path";
import { t } from "@shared/i18n/main";
import { ResourceName } from "@/common/constant";
import messageBus from "@shared/message-bus/main";

/**
 * 设置缩略图按钮
 * @param window 当前窗口
 * @param isPlaying 当前是否正在播放音乐
 */
function setThumbBarButtons(window: BrowserWindow, isPlaying?: boolean) {
    if (!window) {
        return;
    }

    window.setThumbarButtons([
        {
            icon: nativeImage.createFromPath(getResourcePath(ResourceName.SKIP_LEFT_ICON)),
            tooltip: t("main.previous_music"),
            click() {
                messageBus.sendCommand("SkipToPrevious");
            },
        },
        {
            icon: nativeImage.createFromPath(
                getResourcePath(isPlaying ? ResourceName.PAUSE_ICON : ResourceName.PLAY_ICON),
            ),
            tooltip: isPlaying
                ? t("media.music_state_pause")
                : t("media.music_state_play"),
            click() {
                messageBus.sendCommand(
                    "TogglePlayerState",
                );
            },
        },
        {
            icon: nativeImage.createFromPath(getResourcePath(ResourceName.SKIP_RIGHT_ICON)),
            tooltip: t("main.next_music"),
            click() {
                messageBus.sendCommand("SkipToNext");
            },
        },
    ]);

}

// Tauri 移植（计划 §0）：任务栏封面缩略图（TaskbarThumbnailManager.node + sharp）已放弃并删除
// thumbar 按钮在 Tauri 版由 Rust ITaskbarList3 重写（阶段5）

const ThumbBarManager = {
    setThumbBarButtons,
};

export default ThumbBarManager;
