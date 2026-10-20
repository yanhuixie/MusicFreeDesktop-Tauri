/**
 * Tauri 版 window-drag renderer（阶段1）
 * 原实现：win32 用主进程 hookWindowMessage 全窗口拖拽，其他平台 mousemove 增量代理。
 * Tauri 统一方案：mousedown 时调用 WebviewWindow.startDragging()，
 * 非交互元素（按钮/输入/链接等）不触发，等效于 Electron 的全窗口可拖拽。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE_SELECTOR = "button, input, textarea, select, a, [role=button], [data-no-drag]";

let injected = false;

function injectHandler() {
    const task = () =>
        setTimeout(() => {
            if (injected) {
                return;
            }
            injected = true;

            window.addEventListener("mousedown", (e) => {
                if (e.button !== 0) {
                    return;
                }
                const target = e.target as HTMLElement | null;
                if (!target) {
                    return;
                }
                if (target.closest?.(INTERACTIVE_SELECTOR)) {
                    return;
                }
                // 选中文字时不拖拽
                const selection = window.getSelection();
                if (selection && selection.toString()) {
                    return;
                }
                getCurrentWindow().startDragging();
            });
        });

    if (document.readyState === "complete") {
        task();
    } else {
        window.addEventListener("load", task);
    }
}

const WindowDrag = {
    injectHandler,
};

export default WindowDrag;
