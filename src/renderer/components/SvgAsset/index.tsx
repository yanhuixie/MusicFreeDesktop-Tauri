import { memo } from "react";
import type { ComponentType } from "react";

// Vite 迁移：原 webpack 动态 require 改为 import.meta.glob 静态收集
const iconModules = import.meta.glob("@/assets/icons/*.svg", {
    eager: true,
    query: "?react",
    import: "default",
}) as Record<string, ComponentType<any>>;

const iconCache: Record<string, ComponentType<any>> = {};
for (const [filePath, component] of Object.entries(iconModules)) {
    const iconName = filePath.match(/([^/]+)\.svg$/)?.[1];
    if (iconName) {
        iconCache[iconName] = component;
    }
}

export type SvgAssetIconNames =
    | "album"
    | "array-download-tray"
    | "arrow-left-end-on-rectangle"
    | "cd"
    | "chat-bubble-left-ellipsis"
    | "check"
    | "check-circle"
    | "chevron-double-down"
    | "chevron-double-up"
    | "chevron-down"
    | "chevron-left"
    | "chevron-right"
    | "clock"
    | "code-bracket-square"
    | "cog-8-tooth"
    | "dashboard-speed"
    | "document-plus"
    | "fire"
    | "folder-open"
    | "font-size-larger"
    | "font-size-smaller"
    | "hand-thumb-up"
    | "headphone"
    | "heart-outline"
    | "heart"
    | "identification"
    | "language"
    | "list-bullet"
    | "lock-closed"
    | "lock-open"
    | "logo"
    | "lyric"
    | "lyric-en"
    | "magnifying-glass"
    | "minus"
    | "motion-play"
    | "musical-note"
    | "pause"
    | "pencil-square"
    | "picture-in-picture-line"
    | "play"
    | "playlist"
    | "plus"
    | "plus-circle"
    | "question-mark-circle"
    | "repeat-song-1"
    | "repeat-song"
    | "rolling-1s"
    | "shuffle"
    | "skip-left"
    | "skip-right"
    | "sort"
    | "sort-asc"
    | "sort-desc"
    | "sparkles"
    | "speaker-wave"
    | "speaker-x-mark"
    | "square"
    | "trash"
    | "trophy"
    | "t-shirt-line"
    | "user"
    | "lq"
    | "sd"
    | "hq"
    | "sq"
    | "x-mark";

interface IProps {
    iconName: SvgAssetIconNames;
    size?: number;
    title?: string;
    color?: string;
}
/**
 *
 * @param props
 * @returns
 */
function SvgAsset(props: IProps) {
    const Svg = iconCache[props.iconName];

    return (
        <Svg
            title={props.title}
            style={{
                width: props.size,
                height: props.size,
                color: props.color,
            }}
        ></Svg>
    );
}

export default memo(SvgAsset, (prev, curr) => prev.iconName === curr.iconName);
