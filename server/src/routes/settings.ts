import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CONFIG_DIR, THEME_FAVICON_TS } from "../config.js";
import { deleteSiteBannerImage } from "../adapters/storage.js";
import { flattenPatches, patchYaml, readYaml } from "../lib/yamlPatch.js";

/**
 * 主题默认 favicon（src/constants/icon.ts）。内容仓 favicon 为空时的实际生效图标，
 * 只作只读预览提示带回给 client，绝不写回内容仓 yaml（保持最小化覆盖）。
 */
let themeFaviconCache: { src: string; theme: string }[] | null = null;

async function themeFaviconDefaults(): Promise<{ src: string; theme: string }[]> {
	if (themeFaviconCache) return themeFaviconCache;
	try {
		// server 经 tsx 直跑，可即时加载主题 TS 源（该文件仅含类型导入，无运行时依赖）
		const mod = (await import(pathToFileURL(THEME_FAVICON_TS).href)) as {
			defaultFavicons?: { src: string; theme?: string }[];
		};
		themeFaviconCache = (mod.defaultFavicons ?? []).map((f) => ({ src: f.src, theme: f.theme ?? "" }));
	} catch {
		// 主题升级改动了文件位置时静默降级为空列表，不影响站点配置读写
		themeFaviconCache = [];
	}
	return themeFaviconCache;
}

const THEME_STYLES = [
	"tonalSpot",
	"vibrant",
	"content",
	"expressive",
	"rainbow",
	"fruitSalad",
	"monochrome",
	"neutral",
	"fidelity",
] as const;
const TEXTURE_PRESETS = ["none", "starlight", "cyber-dots", "topography", "geometric", "sakura"] as const;
const CAROUSEL_ANIMATIONS = ["ken-burns", "zoom-in", "zoom-out", "pan-left", "pan-right", "none"] as const;
const SITE_LANGS = ["en", "zh_CN", "zh_TW", "ja", "ko", "es", "th", "vi", "tr", "id"] as const;
const DISPLAY_KEYS = [
	"colorStyle",
	"colorSpec",
	"wallpaperMode",
	"layoutMode",
	"reduceMotion",
	"texture",
] as const;

const sitePutSchema = z.object({
	site: z.string().min(1).optional(),
	base: z.string().min(1).optional(),
	title: z.string().min(1).optional(),
	subtitle: z.string().optional(),
	lang: z.enum(SITE_LANGS).optional(),
	i18n: z
		.object({
			enable: z.boolean().optional(),
			locales: z.array(z.enum(SITE_LANGS)).min(1).optional(),
		})
		.optional(),
	timeZone: z.string().min(2).optional(),
	displaySettings: z.object(
		Object.fromEntries(DISPLAY_KEYS.map((k) => [k, z.boolean().optional()])),
	).optional(),
	themeColor: z
		.object({
			hue: z.number().int().min(0).max(360).optional(),
			fixed: z.boolean().optional(),
			style: z.enum(THEME_STYLES).optional(),
			spec: z.enum(["2021", "2025"]).optional(),
		})
		.optional(),
	wallpaperMode: z.object({ defaultMode: z.enum(["banner", "none"]).optional() }).optional(),
	texture: z
		.object({
			enable: z.boolean().optional(),
			defaultPreset: z.enum(TEXTURE_PRESETS).optional(),
			defaultOpacity: z.number().min(0.05).max(0.25).optional(),
			allowMotion: z.boolean().optional(),
		})
		.optional(),
	banner: z
		.object({
			src: z
				.object({
					desktop: z.array(z.string()).optional(),
					mobile: z.array(z.string()).optional(),
				})
				.optional(),
			position: z.enum(["top", "center", "bottom"]).optional(),
			dim: z
				.object({
					enable: z.boolean().optional(),
					opacity: z.number().min(0).max(1).optional(),
				})
				.optional(),
			homeText: z
				.object({
					enable: z.boolean().optional(),
					title: z.string().optional(),
					subtitle: z.array(z.string()).optional(),
					typewriter: z
						.object({
							enable: z.boolean().optional(),
							speed: z.number().int().min(10).optional(),
							deleteSpeed: z.number().int().min(10).optional(),
							pauseTime: z.number().int().min(0).optional(),
							loop: z.boolean().optional(),
						})
						.optional(),
				})
				.optional(),
			carousel: z
				.object({
					enable: z.boolean().optional(),
					interval: z.number().int().min(3000).optional(),
					fadeDuration: z.number().int().min(0).optional(),
					animation: z.enum(CAROUSEL_ANIMATIONS).optional(),
				})
				.optional(),
			waves: z.object({ enable: z.boolean().optional() }).optional(),
		})
		.optional(),
	favicon: z
		.array(z.object({ src: z.string().min(1), theme: z.string().min(1) }))
		.optional(),
});

const profilePutSchema = z.object({
	avatar: z.string().optional(),
	name: z.string().optional(),
	bio: z.string().optional(),
	links: z
		.array(
			z.object({
				name: z.string().min(1),
				icon: z.string().default(""),
				url: z.string().min(1),
			}),
		)
		.optional(),
});

interface NavChildShape {
	preset?: string;
	name?: string;
	icon?: string;
	url?: string;
	external?: boolean;
	children?: NavChildShape[];
}

const navChildSchema: z.ZodType<NavChildShape> = z.lazy(() =>
	z.object({
		preset: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		icon: z.string().optional(),
		url: z.string().optional(),
		external: z.boolean().optional(),
		children: z.array(navChildSchema).optional(),
	}),
);

const navbarPutSchema = z.object({
	links: z.array(navChildSchema).optional(),
});

const footerPutSchema = z.object({
	enable: z.boolean().optional(),
	html: z.string().optional(),
});

const domainParam = z.object({
	domain: z.enum(["site", "profile", "navbar", "footer"]),
});

/** site.yaml 横幅两端的引用列表（拍平成 string[]，缺省视为空） */
function bannerSrcListOf(yaml: Record<string, unknown>): string[] {
	const banner = yaml.banner;
	const src = (typeof banner === "object" && banner !== null ? (banner as { src?: unknown }).src : undefined) as
		| { desktop?: unknown; mobile?: unknown }
		| undefined;
	const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
	return [...list(src?.desktop), ...list(src?.mobile)];
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/settings/:domain", async (req) => {
		const { domain } = domainParam.parse(req.params);
		switch (domain) {
			case "site": {
				const [site, themeFavicon] = await Promise.all([
					readYaml(path.join(CONFIG_DIR, "site.yaml")),
					themeFaviconDefaults(),
				]);
				return { ...site, themeFavicon };
			}
			case "profile":
				return readYaml(path.join(CONFIG_DIR, "profile.yaml"));
			case "navbar":
				return readYaml(path.join(CONFIG_DIR, "nav-bar.yaml"));
			case "footer": {
				const yaml = await readYaml(path.join(CONFIG_DIR, "footer.yaml"));
				const html = await fs.readFile(path.join(CONFIG_DIR, "footer.html"), "utf8").catch(() => "");
				return { enable: Boolean(yaml.enable), html };
			}
		}
	});

	app.put("/api/settings/:domain", async (req) => {
		const { domain } = domainParam.parse(req.params);
		switch (domain) {
			case "site": {
				const body = sitePutSchema.parse(req.body);
				const yamlPath = path.join(CONFIG_DIR, "site.yaml");
				// 横幅更新前快照；保存成功后清理不再被桌面/移动任何一端引用的本地壁纸文件
				const bannerBefore = body.banner ? bannerSrcListOf(await readYaml(yamlPath)) : null;
				await patchYaml(yamlPath, flattenPatches(body));
				if (bannerBefore) {
					const kept = new Set(bannerSrcListOf(await readYaml(yamlPath)));
					for (const src of bannerBefore) {
						if (!kept.has(src)) await deleteSiteBannerImage(src);
					}
				}
				return readYaml(yamlPath);
			}
			case "profile": {
				const body = profilePutSchema.parse(req.body);
				await patchYaml(path.join(CONFIG_DIR, "profile.yaml"), flattenPatches(body));
				return readYaml(path.join(CONFIG_DIR, "profile.yaml"));
			}
			case "navbar": {
				const body = navbarPutSchema.parse(req.body);
				if (body.links === undefined) return readYaml(path.join(CONFIG_DIR, "nav-bar.yaml"));
				await patchYaml(path.join(CONFIG_DIR, "nav-bar.yaml"), [{ path: ["links"], value: body.links }]);
				return readYaml(path.join(CONFIG_DIR, "nav-bar.yaml"));
			}
			case "footer": {
				const body = footerPutSchema.parse(req.body);
				if (body.enable !== undefined) {
					await patchYaml(path.join(CONFIG_DIR, "footer.yaml"), [
						{ path: ["enable"], value: body.enable },
					]);
				}
				if (body.html !== undefined) {
					await fs.writeFile(path.join(CONFIG_DIR, "footer.html"), body.html.replace(/\s+$/, "\n"));
				}
				const yaml = await readYaml(path.join(CONFIG_DIR, "footer.yaml"));
				const html = await fs.readFile(path.join(CONFIG_DIR, "footer.html"), "utf8").catch(() => "");
				return { enable: Boolean(yaml.enable), html };
			}
		}
	});
}
