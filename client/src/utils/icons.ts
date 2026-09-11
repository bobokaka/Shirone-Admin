/**
 * 离线图标集合注册（本工具不访问任何在线图标服务）。
 * 内置与主题仓一致的三个 @iconify-json 集合，启动时 addCollection 进 @iconify/vue，
 * 图标数据全部来自本地依赖，运行时零网络请求；未收录的图标名由 DataIcon 降级首字母块，
 * 不会回退到 api.iconify.design。新增前缀需求时在此补装对应 @iconify-json 包并注册。
 */
import { addCollection, iconLoaded } from "@iconify/vue";
import { icons as fa6Brands } from "@iconify-json/fa6-brands";
import { icons as materialSymbols } from "@iconify-json/material-symbols";
import { icons as simpleIcons } from "@iconify-json/simple-icons";

addCollection(materialSymbols);
addCollection(fa6Brands);
addCollection(simpleIcons);

/** 内置离线集合的 Iconify 前缀清单（提示文案用） */
export const BUNDLED_ICON_PREFIXES = ["material-symbols", "fa6-brands", "simple-icons"];

/** 内置集合的图标名清单（图标库选择器枚举用；与注册同源，不重复打包） */
export const BUNDLED_COLLECTIONS: { prefix: string; names: string[] }[] = [
	materialSymbols,
	fa6Brands,
	simpleIcons,
].map((c) => ({
	prefix: c.prefix,
	names: [...Object.keys(c.icons), ...Object.keys(c.aliases ?? {})],
}));

/**
 * 图标名是否在内置离线集合中（同步判定，不触发网络请求）。
 * 名字格式非法（缺冒号前缀等）直接返回 false。
 */
export function hasLocalIcon(name: string): boolean {
	return iconLoaded(name);
}
