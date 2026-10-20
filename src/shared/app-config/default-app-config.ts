import { IAppConfig } from "@/types/app-config";

// Tauri 移植（阶段1）：默认配置数据源改为 JSON，与 Rust 侧 include_str! 同源
// （src-tauri/src/app_config.rs），避免双端默认值漂移
import _defaultAppConfig from "./default-app-config.json";

const defaultAppConfig = _defaultAppConfig as unknown as IAppConfig;

export default defaultAppConfig;
