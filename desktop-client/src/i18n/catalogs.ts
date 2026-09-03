export const zhCN = {
  "records.count": "{count} 条记录",
  "terminal.readFailed": "无法读取会话：{error}",
  "settings.language": "界面语言",
  "settings.languageDescription": "默认跟随系统语言，也可以仅为 AFK Control 选择语言。",
  "settings.locale.system": "跟随系统",
  "settings.locale.zh-CN": "简体中文",
  "settings.locale.en-US": "English",
} as const;

export type MessageKey = keyof typeof zhCN;
export type Catalog = Record<MessageKey, string>;

export const enUS: Catalog = {
  "records.count": "{count} records",
  "terminal.readFailed": "Unable to read session: {error}",
  "settings.language": "Language",
  "settings.languageDescription": "Follow the system language by default, or choose a language for AFK Control only.",
  "settings.locale.system": "System",
  "settings.locale.zh-CN": "简体中文",
  "settings.locale.en-US": "English",
};
