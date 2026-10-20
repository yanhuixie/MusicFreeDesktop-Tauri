import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import path from "path";

// Tauri 移植：原 webpack(electron-forge) 多入口配置的 Vite 等价物
// 入口与 config/webpack.renderer.config.ts + forge.config.ts entryPoints 对齐
export default defineConfig({
    plugins: [
        react(),
        svgr({
            svgrOptions: {
                prettier: false,
                svgo: false,
                titleProp: true,
                ref: true,
            },
        }),
    ],
    // Tauri 以相对路径加载 frontendDist
    base: "./",
    resolve: {
        extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".scss"],
        alias: {
            "@": path.join(__dirname, "./src"),
            "@renderer": path.join(__dirname, "./src/renderer"),
            "@renderer-lrc": path.join(__dirname, "./src/renderer-lrc"),
            "@renderer-minimode": path.join(__dirname, "./src/renderer-minimode"),
            "@shared": path.join(__dirname, "./src/shared"),
        },
    },
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
    },
    build: {
        rollupOptions: {
            input: {
                main: path.join(__dirname, "./index.html"),
                lrc: path.join(__dirname, "./lrc.html"),
                minimode: path.join(__dirname, "./minimode.html"),
                "plugin-runtime": path.join(__dirname, "./plugin-runtime.html"),
            },
        },
    },
});
