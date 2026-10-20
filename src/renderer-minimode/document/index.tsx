// Tauri 迁移：必须最先执行，注入尚未迁移模块的 window["@shared/*"] 桩
import "@shared/tauri/stub";
import ReactDOM from "react-dom/client";

import bootstrap from "./bootstrap";

import MinimodePage from "../pages";
import { useEffect } from "react";
import { setupGlobalContext } from "@shared/global-context/renderer";

import "animate.css";
import "rc-slider/assets/index.css";
import "react-toastify/dist/ReactToastify.css";
import "./styles/index.scss"; // 全局样式
import WindowDrag from "@shared/window-drag/renderer";

setupGlobalContext().then(bootstrap).then(() => {
    ReactDOM.createRoot(document.getElementById("root")).render(<Root></Root>);
});

function Root() {

    useEffect(() => {
        WindowDrag.injectHandler();
    }, []);

    return <MinimodePage></MinimodePage>;
}
