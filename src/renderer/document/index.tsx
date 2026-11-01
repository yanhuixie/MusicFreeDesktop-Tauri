// Tauri 迁移：必须最先执行，注入尚未迁移模块的 window["@shared/*"] 桩
import "@shared/tauri/stub";
import ReactDOM from "react-dom/client";
import App from "../app";
import { localPluginName, toastDuration } from "@/common/constant";
import { setupGlobalContext } from "@shared/global-context/renderer";

// Tauri 迁移：Electron 版由 window-manager 设置初始 hash（收藏歌单页），此处对齐
if (!location.hash) {
    location.hash = `#/main/musicsheet/${localPluginName}/favorite`;
}
import "animate.css";
import ModalComponent from "../components/Modal";
import bootstrap from "./bootstrap";
import { HashRouter, Route, Routes } from "react-router-dom";
import MainPage from "../pages/main-page";
import { ContextMenuComponent } from "../components/ContextMenu";
import { ToastContainer } from "react-toastify";

import "rc-slider/assets/index.css";
import "react-toastify/dist/ReactToastify.css";
import "./styles/index.scss"; // 全局样式
import useBootstrap from "./useBootstrap";
import logger from "@shared/logger/renderer";
import { ErrorBoundary } from "react-error-boundary";
import Fallback from "@renderer/document/fallback";
import AppConfig from "@shared/app-config/renderer";
import trackPlayer from "../core/track-player";

logger.logPerf("Create Bundle");

function renderApp() {
    ReactDOM.createRoot(document.getElementById("root")).render(<ErrorBoundary
        FallbackComponent={Fallback} onReset={() => {
            // 删除软件配置
            AppConfig.reset();
            trackPlayer.reset();
        }}><Root></Root></ErrorBoundary>);
}

setupGlobalContext()
    .then(bootstrap)
    .then(() => {
        logger.logPerf("Bundle Bootstrap Ready");
    })
    .catch((e) => {
        // 启动初始化失败也要渲染（交给 ErrorBoundary / 空状态兜底），不能留白屏
        logger.logError("启动初始化失败", e);
    })
    .finally(renderApp);

function Root() {
    return (
        <>
            <HashRouter>
                <BootstrapComponent></BootstrapComponent>
                <Routes>
                    <Route path="/" element={<App></App>}>
                        <Route path="main/*" element={<MainPage></MainPage>}></Route>
                        <Route path="*" element={<MainPage></MainPage>}></Route>
                    </Route>
                </Routes>
                <ModalComponent></ModalComponent>
            </HashRouter>
            <ContextMenuComponent></ContextMenuComponent>
            <ToastContainer
                draggable={false}
                closeOnClick={false}
                limit={5}
                pauseOnFocusLoss={false}
                hideProgressBar
                autoClose={toastDuration.short}
                newestOnTop
            ></ToastContainer>
        </>
    );
}

function BootstrapComponent(): null {
    useBootstrap();

    return null;
}
