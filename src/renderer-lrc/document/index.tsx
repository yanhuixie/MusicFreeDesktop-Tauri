// Tauri 迁移：必须最先执行，注入 Electron preload 等价的 window["@shared/*"] 桩
import "@shared/tauri/stub";
import ReactDOM from "react-dom/client";
import bootstrap from "./bootstrap";
import LyricWindowPage from "../pages";
import { useEffect } from "react";

import "animate.css";
import "rc-slider/assets/index.css";
import "react-toastify/dist/ReactToastify.css";
import "./styles/index.scss"; // 全局样式
import WindowDrag from "@shared/window-drag/renderer";

bootstrap().then(() => {
    ReactDOM.createRoot(document.getElementById("root")).render(<Root></Root>);
});

function Root() {
    useEffect(() => {
        WindowDrag.injectHandler();
    }, []);

    return <LyricWindowPage></LyricWindowPage>;
}
