/**
 * 常用 IANA 时区下拉选项：标签为「(GMT+08:00) 中文名（IANA 名）」。
 * 偏移用 Intl 按当前日期动态计算（夏令时区随季节自动正确），按偏移升序排列。
 */

const ZONES: { value: string; zh: string }[] = [
	{ value: "UTC", zh: "协调世界时" },
	{ value: "Asia/Shanghai", zh: "中国标准时间" },
	{ value: "Asia/Taipei", zh: "台北时间" },
	{ value: "Asia/Hong_Kong", zh: "香港时间" },
	{ value: "Asia/Macau", zh: "澳门时间" },
	{ value: "Asia/Tokyo", zh: "日本标准时间" },
	{ value: "Asia/Seoul", zh: "韩国标准时间" },
	{ value: "Asia/Singapore", zh: "新加坡标准时间" },
	{ value: "Asia/Kuala_Lumpur", zh: "马来西亚时间" },
	{ value: "Asia/Manila", zh: "菲律宾时间" },
	{ value: "Asia/Jakarta", zh: "西印度尼西亚时间" },
	{ value: "Asia/Bangkok", zh: "印度支那时间" },
	{ value: "Asia/Ho_Chi_Minh", zh: "越南时间" },
	{ value: "Asia/Phnom_Penh", zh: "柬埔寨时间" },
	{ value: "Asia/Kolkata", zh: "印度标准时间" },
	{ value: "Asia/Colombo", zh: "斯里兰卡时间" },
	{ value: "Asia/Dhaka", zh: "孟加拉时间" },
	{ value: "Asia/Kathmandu", zh: "尼泊尔时间" },
	{ value: "Asia/Tashkent", zh: "乌兹别克斯坦时间" },
	{ value: "Asia/Almaty", zh: "阿拉木图时间" },
	{ value: "Asia/Karachi", zh: "巴基斯坦时间" },
	{ value: "Asia/Dubai", zh: "海湾标准时间" },
	{ value: "Asia/Tehran", zh: "伊朗标准时间" },
	{ value: "Asia/Yekaterinburg", zh: "叶卡捷琳堡时间" },
	{ value: "Asia/Novosibirsk", zh: "新西伯利亚时间" },
	{ value: "Asia/Irkutsk", zh: "伊尔库茨克时间" },
	{ value: "Asia/Yakutsk", zh: "雅库茨克时间" },
	{ value: "Asia/Vladivostok", zh: "符拉迪沃斯托克时间" },
	{ value: "Asia/Magadan", zh: "马加丹时间" },
	{ value: "Asia/Kamchatka", zh: "堪察加时间" },
	{ value: "Australia/Perth", zh: "澳大利亚西部时间" },
	{ value: "Australia/Adelaide", zh: "澳大利亚中部时间" },
	{ value: "Australia/Brisbane", zh: "澳大利亚东部时间（布里斯班）" },
	{ value: "Australia/Sydney", zh: "澳大利亚东部时间（悉尼）" },
	{ value: "Pacific/Auckland", zh: "新西兰时间" },
	{ value: "Pacific/Fiji", zh: "斐济时间" },
	{ value: "Pacific/Honolulu", zh: "夏威夷时间" },
	{ value: "America/Anchorage", zh: "阿拉斯加时间" },
	{ value: "America/Los_Angeles", zh: "太平洋时间（美国/加拿大）" },
	{ value: "America/Denver", zh: "山地时间（美国/加拿大）" },
	{ value: "America/Phoenix", zh: "山地时间（亚利桑那）" },
	{ value: "America/Chicago", zh: "中部时间（美国/加拿大）" },
	{ value: "America/Mexico_City", zh: "中部时间（墨西哥）" },
	{ value: "America/New_York", zh: "东部时间（美国/加拿大）" },
	{ value: "America/Havana", zh: "古巴时间" },
	{ value: "America/Bogota", zh: "哥伦比亚时间" },
	{ value: "America/Lima", zh: "秘鲁时间" },
	{ value: "America/Santiago", zh: "智利时间" },
	{ value: "America/Sao_Paulo", zh: "巴西利亚时间" },
	{ value: "America/Argentina/Buenos_Aires", zh: "阿根廷时间" },
	{ value: "Atlantic/Reykjavik", zh: "格林尼治时间（雷克雅未克）" },
	{ value: "Europe/London", zh: "格林尼治标准时间" },
	{ value: "Europe/Lisbon", zh: "西欧时间（里斯本）" },
	{ value: "Europe/Madrid", zh: "中欧时间（马德里）" },
	{ value: "Europe/Paris", zh: "中欧时间（巴黎）" },
	{ value: "Europe/Amsterdam", zh: "中欧时间（阿姆斯特丹）" },
	{ value: "Europe/Berlin", zh: "中欧时间（柏林）" },
	{ value: "Europe/Zurich", zh: "中欧时间（苏黎世）" },
	{ value: "Europe/Rome", zh: "中欧时间（罗马）" },
	{ value: "Europe/Vienna", zh: "中欧时间（维也纳）" },
	{ value: "Europe/Prague", zh: "中欧时间（布拉格）" },
	{ value: "Europe/Warsaw", zh: "中欧时间（华沙）" },
	{ value: "Europe/Stockholm", zh: "中欧时间（斯德哥尔摩）" },
	{ value: "Europe/Oslo", zh: "中欧时间（奥斯陆）" },
	{ value: "Europe/Copenhagen", zh: "中欧时间（哥本哈根）" },
	{ value: "Europe/Helsinki", zh: "东欧时间（赫尔辛基）" },
	{ value: "Europe/Athens", zh: "东欧时间（雅典）" },
	{ value: "Europe/Istanbul", zh: "土耳其时间" },
	{ value: "Europe/Kyiv", zh: "东欧时间（基辅）" },
	{ value: "Europe/Bucharest", zh: "东欧时间（布加勒斯特）" },
	{ value: "Europe/Moscow", zh: "莫斯科时间" },
	{ value: "Africa/Casablanca", zh: "摩洛哥时间" },
	{ value: "Africa/Cairo", zh: "埃及时间" },
	{ value: "Africa/Lagos", zh: "西非时间" },
	{ value: "Africa/Johannesburg", zh: "南非标准时间" },
	{ value: "Africa/Nairobi", zh: "东非时间" },
];

interface TimezoneOption {
	value: string;
	label: string;
	offsetMinutes: number;
}

/** longOffset 形如 "GMT+08:00" / "GMT-05:30" / "GMT"，取不到时回退空串 */
function gmtLabel(tz: string): string {
	try {
		return (
			new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
				.formatToParts(new Date())
				.find((p) => p.type === "timeZoneName")?.value ?? ""
		);
	} catch {
		return "";
	}
}

function offsetMinutesOf(gmt: string): number {
	if (!gmt || gmt === "GMT") return 0;
	const m = gmt.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
	if (!m) return Number.NaN;
	const sign = m[1] === "-" ? -1 : 1;
	return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = ZONES.map(({ value, zh }) => {
	const gmt = gmtLabel(value);
	return {
		value,
		label: gmt ? `(${gmt}) ${zh}（${value}）` : `${zh}（${value}）`,
		offsetMinutes: offsetMinutesOf(gmt),
	};
}).sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label, "zh"));
