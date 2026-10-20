import i18n from "i18next";
import Store from "@/common/store";
import { initReactI18next } from "react-i18next";
import AppConfig from "@shared/app-config/renderer";

/**
 * Tauri 版 i18n renderer（阶段1）
 * 原实现：主进程 fs 读 res/lang，语言包经 IPC 下发。
 * 现：语言包 res/lang/*.json 直接打包进前端（import.meta.glob），
 * 语言选择持久化到 app-config "normal.language"（对齐主进程 onLanguageChanged）。
 */

i18n.use(initReactI18next);

const ns = "translation";

const langListStore = new Store<string[]>([]);

const langModules = import.meta.glob("../../../res/lang/*.json", {
    eager: true,
    import: "default",
}) as Record<string, any>;

const langContents: Record<string, any> = {};
for (const [filePath, content] of Object.entries(langModules)) {
    const langName = filePath.match(/([^/]+)\.json$/)?.[1];
    if (langName) {
        langContents[langName] = content;
    }
}
const allLangs = Object.keys(langContents);

function readLangContent(langCode: string): any | null {
    const content = langContents[langCode];
    if (!content) return null;
    // 对齐主进程版 $alias 重定向逻辑
    if (content["$alias"] && langContents[content["$alias"]]) {
        return langContents[content["$alias"]];
    }
    return content;
}

function pickDefaultLang(): string {
    // 配置的语言优先
    const configured = AppConfig.getConfig("normal.language");
    if (configured && allLangs.includes(configured)) {
        return configured;
    }
    const nav = navigator.language;
    if (allLangs.includes(nav)) return nav;
    if (nav.includes("zh") && allLangs.includes("zh-CN")) return "zh-CN";
    if (allLangs.includes("en-US")) return "en-US";
    return allLangs[0];
}

export async function setupI18n() {
    const lang = pickDefaultLang();
    langListStore.setValue(allLangs);
    await i18n.init({
        resources: {
            [lang]: {
                [ns]: readLangContent(lang) || {},
            },
        },
        lng: lang,
    });
}

export async function changeLang(lang: string): Promise<boolean> {
    const langData = readLangContent(lang);
    if (!langData) {
        return false;
    }
    if (i18n.hasResourceBundle(lang, ns)) {
        await i18n.changeLanguage(lang);
    } else {
        i18n.addResourceBundle(lang, ns, langData);
        await i18n.changeLanguage(lang);
    }
    // 持久化语言选择（对齐原主进程行为）
    AppConfig.setConfig({ "normal.language": lang });
    return true;
}

export const useLangList = langListStore.useValue;

export const getLangList = langListStore.getValue;

export const isCN = () => i18n.language.includes("zh-CN");

export { i18n };


export default {
    setupI18n,
    changeLang,
    useLangList,
    getLangList,
    i18n,
};
