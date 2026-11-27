/**
 * Recipe for the `system` theme: each token's color family and the contrast rules it must meet.
 * `system-theme.ts` describes the method and generates colors from this recipe.
 */

import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme-types.ts";

// Recipe: color families and their tokens

/** A family's OKHSL hue and saturation: `max` at mid lightness, falling toward `min` at black and white. */
export interface Family {
	hue: number;
	saturation: { min: number; max: number };
	/** ANSI palette slot the family takes its hue and saturation from. */
	slot: number;
}

export const FAMILIES = {
	neutral: { hue: 231.49, saturation: { min: 0.02, max: 0.08 }, slot: 8 },
	blue: { hue: 231.49, saturation: { min: 0.1, max: 0.68 }, slot: 4 },
	green: { hue: 158.68, saturation: { min: 0.1, max: 0.76 }, slot: 2 },
	red: { hue: 20, saturation: { min: 0.1, max: 0.92 }, slot: 1 },
	yellow: { hue: 82.36, saturation: { min: 0.5, max: 1 }, slot: 3 },
	orange: { hue: 52, saturation: { min: 0.12, max: 0.85 }, slot: 3 },
	violet: { hue: 295, saturation: { min: 0.2, max: 0.6 }, slot: 5 },
	calamine: { hue: 202.43, saturation: { min: 0.1, max: 0.74 }, slot: 6 },
	thinkingSlate: { hue: 231.49, saturation: { min: 0.08, max: 0.2 }, slot: 4 },
	thinkingBlue: { hue: 231.49, saturation: { min: 0.2, max: 0.45 }, slot: 4 },
	thinkingPeriwinkle: { hue: 263.25, saturation: { min: 0.3, max: 0.6 }, slot: 6 },
	thinkingViolet: { hue: 295, saturation: { min: 0.4, max: 0.75 }, slot: 5 },
	thinkingMagenta: { hue: 337.5, saturation: { min: 0.5, max: 0.85 }, slot: 13 },
	thinkingRed: { hue: 20, saturation: { min: 0.95, max: 1 }, slot: 1 },
} satisfies Record<string, Family>;

export type FamilyName = keyof typeof FAMILIES;

export const TOKEN_FAMILIES: Record<ThemeToken, FamilyName> = {
	selectedBg: "blue",
	searchMatchBg: "orange",
	userMessageBg: "blue",
	customMessageBg: "violet",
	toolPendingBg: "neutral",
	toolSuccessBg: "green",
	toolErrorBg: "red",

	text: "neutral",
	userMessageText: "neutral",
	customMessageText: "neutral",
	toolTitle: "neutral",
	syntaxOperator: "neutral",
	syntaxPunctuation: "neutral",
	muted: "neutral",
	dim: "neutral",
	thinkingText: "neutral",
	toolOutput: "neutral",
	mdLinkUrl: "neutral",
	mdQuote: "neutral",
	mdQuoteBorder: "neutral",
	mdHr: "neutral",
	mdCodeBlockBorder: "neutral",
	toolDiffContext: "neutral",
	syntaxComment: "neutral",
	scrollbarTrack: "neutral",
	scrollbarThumb: "neutral",
	searchMatchText: "neutral",
	borderMuted: "neutral",

	accent: "violet",
	borderAccent: "violet",
	customMessageLabel: "violet",
	mdCode: "violet",
	mdListBullet: "violet",
	syntaxType: "violet",
	border: "blue",
	mdLink: "blue",
	syntaxKeyword: "blue",
	syntaxVariable: "calamine",
	toolReason: "calamine",
	success: "green",
	mdCodeBlock: "green",
	toolDiffAdded: "green",
	bashMode: "green",
	syntaxNumber: "green",
	error: "red",
	toolDiffRemoved: "red",
	warning: "yellow",
	mdHeading: "yellow",
	syntaxFunction: "yellow",
	syntaxString: "orange",

	thinkingOff: "neutral",
	thinkingMinimal: "thinkingSlate",
	thinkingLow: "thinkingBlue",
	thinkingMedium: "thinkingPeriwinkle",
	thinkingHigh: "thinkingViolet",
	thinkingXhigh: "thinkingMagenta",
	thinkingMax: "thinkingRed",
};

/** Palette slots for tokens that would otherwise share a hue with a similar token. */
export const TOKEN_SLOTS: Partial<Record<ThemeToken, number>> = { syntaxString: 2, syntaxNumber: 5, searchMatchBg: 3 };

// Contrast levels and rules

/**
 * Target-lightness curves: a polynomial in the surface's OKLab lightness giving the OKLab lightness a token
 * needs on it. `reachable` is the range of surface lightness where the level can be reached; beyond it the
 * level is relaxed.
 */
export interface Curve {
	coefficients: number[];
	reachable: [number, number];
}

export const LEVELS = {
	panel: {
		dark: { coefficients: [0.29131, -0.39746, 2.33185, -0.85524, -1.2076, 0.86276], reachable: [0, 0.979] },
		light: { coefficients: [-3.74073, 27.94549, -78.44258, 112.6798, -79.60015, 22.11277], reachable: [0.348, 1] },
	},
	track: {
		dark: { coefficients: [0.39028, -0.23015, 0.83573, 2.43829, -4.38292, 2.01582], reachable: [0, 0.946] },
		light: { coefficients: [-5.24921, 38.37322, -107.28833, 152.10005, -106.17127, 29.18061], reachable: [0.368, 1] },
	},
	thinking0: {
		dark: { coefficients: [0.52988, -0.05809, -0.30924, 4.63567, -6.52933, 2.89108], reachable: [0, 0.873] },
		light: {
			coefficients: [-28.27749, 182.85284, -469.62416, 603.15916, -384.59976, 97.35147],
			reachable: [0.51, 1],
		},
	},
	thinking1: {
		dark: { coefficients: [0.55278, -0.03667, -0.45659, 4.95347, -6.90265, 3.0706], reachable: [0, 0.858] },
		light: {
			coefficients: [-37.10484, 235.86282, -596.62344, 754.3633, -474.00763, 118.3551],
			reachable: [0.535, 1],
		},
	},
	thinking2: {
		dark: { coefficients: [0.57486, -0.01765, -0.58987, 5.25227, -7.27175, 3.25532], reachable: [0, 0.842] },
		light: {
			coefficients: [-59.89653, 377.05024, -945.07843, 1182.03145, -734.96375, 181.68658],
			reachable: [0.556, 1],
		},
	},
	thinking3: {
		dark: { coefficients: [0.59621, -0.00062, -0.71148, 5.53588, -7.6392, 3.44606], reachable: [0, 0.827] },
		light: {
			coefficients: [-72.07122, 445.84082, -1099.57352, 1353.88793, -829.53392, 202.26164],
			reachable: [0.58, 1],
		},
	},
	thinking4: {
		dark: { coefficients: [0.61691, 0.01462, -0.82288, 5.80651, -8.00641, 3.64333], reachable: [0, 0.811] },
		light: {
			coefficients: [-110.14338, 674.21488, -1645.75941, 2004.32367, -1215.15899, 293.3183],
			reachable: [0.6, 1],
		},
	},
	thinking5: {
		dark: { coefficients: [0.63702, 0.02826, -0.92498, 6.06465, -8.37246, 3.84651], reachable: [0, 0.795] },
		light: {
			coefficients: [-175.47701, 1063.54495, -2570.70594, 3098.80776, -1860.15527, 444.76392],
			reachable: [0.62, 1],
		},
	},
	thinking6: {
		dark: { coefficients: [0.65658, 0.04044, -1.01835, 6.30989, -8.73529, 4.05439], reachable: [0, 0.779] },
		light: {
			coefficients: [-183.81712, 1094.70055, -2602.68539, 3088.71276, -1826.91131, 430.75931],
			reachable: [0.643, 1],
		},
	},
	subtle: {
		dark: { coefficients: [0.56762, -0.02475, -0.5383, 5.12628, -7.10931, 3.17324], reachable: [0, 0.848] },
		light: {
			coefficients: [-232.85459, 1376.54473, -3249.11801, 3827.91186, -2248.29472, 526.55751],
			reachable: [0.657, 1],
		},
	},
	thumb: {
		dark: { coefficients: [0.60323, 0.00278, -0.73328, 5.57157, -7.68067, 3.46933], reachable: [0, 0.823] },
		light: {
			coefficients: [-82.89897, 511.01355, -1255.98095, 1540.76821, -940.68087, 228.58523],
			reachable: [0.586, 1],
		},
	},
	readable: {
		dark: { coefficients: [0.66937, 0.04704, -1.06871, 6.43941, -8.9332, 4.17229], reachable: [0, 0.77] },
		light: {
			coefficients: [-1554.52576, 8733.56817, -19604.93507, 21977.72696, -12300.99599, 2749.81288],
			reachable: [0.751, 1],
		},
	},
	emphasis: {
		dark: { coefficients: [0.7303, 0.07695, -1.31626, 7.1681, -10.14436, 4.92846], reachable: [0, 0.712] },
		light: {
			coefficients: [-4948.31942, 26870.91986, -58334.48399, 63280.17197, -34298.01053, 7430.30146],
			reachable: [0.811, 1],
		},
	},
	textOnPanel: {
		dark: { coefficients: [0.86713, 0.05232, -0.89428, 4.79014, -5.5432, 1.75023], reachable: [0, 0.542] },
		light: {
			coefficients: [-8570.89457, 43954.60805, -90084.00702, 92220.6791, -47152.15802, 9632.27113],
			reachable: [0.867, 1],
		},
	},
	text: {
		dark: { coefficients: [0.89242, 0.02311, -0.44862, 2.34417, -0.06084, -2.63844], reachable: [0, 0.5] },
		light: {
			coefficients: [-2004.67048, 6664.47299, -6060.70202, -1792.61209, 5133.82359, -1939.85583],
			reachable: [0.894, 1],
		},
	},
} satisfies Record<string, Record<ThemeAppearance, Curve>>;

export type Level = keyof typeof LEVELS;

export type Surface = ThemeBg | "background" | "scrollbarTrack";

interface Rule {
	token: ThemeToken;
	on: Surface[];
	level: Level;
}

const TOOL_PANELS: Surface[] = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];
const MESSAGE_PANELS: Surface[] = ["userMessageBg", "customMessageBg"];
export const PANELS: ThemeBg[] = [
	"userMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"selectedBg",
	"searchMatchBg",
	"customMessageBg",
];
const THINKING: ThemeColor[] = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
];
const THINKING_LEVELS: Level[] = [
	"thinking0",
	"thinking1",
	"thinking2",
	"thinking3",
	"thinking4",
	"thinking5",
	"thinking6",
];

const each = (tokens: ThemeToken[], on: Surface[], level: Level): Rule[] =>
	tokens.map((token) => ({ token, on, level }));

export const RULES: Rule[] = [
	...each(PANELS, ["background"], "panel"),
	{ token: "text", on: ["background"], level: "text" },
	{ token: "text", on: ["selectedBg"], level: "textOnPanel" },
	{ token: "userMessageText", on: ["userMessageBg"], level: "textOnPanel" },
	{ token: "toolTitle", on: TOOL_PANELS, level: "textOnPanel" },
	...each(["accent", "success", "error", "warning"], ["background", "selectedBg", ...TOOL_PANELS], "readable"),
	{ token: "muted", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "readable" },
	{ token: "dim", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "subtle" },
	{ token: "thinkingText", on: ["background"], level: "readable" },
	{ token: "customMessageText", on: ["customMessageBg", ...TOOL_PANELS], level: "readable" },
	{
		token: "customMessageLabel",
		on: ["background", "customMessageBg", "selectedBg", ...TOOL_PANELS],
		level: "readable",
	},
	{ token: "toolOutput", on: ["background", ...TOOL_PANELS], level: "readable" },
	{ token: "toolReason", on: ["background", ...TOOL_PANELS], level: "readable" },
	...each(
		["mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdQuote", "mdCodeBlockBorder", "mdListBullet"],
		["background", ...MESSAGE_PANELS],
		"readable",
	),
	{ token: "mdCodeBlock", on: ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], level: "readable" },
	...each(["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"], ["background", ...TOOL_PANELS], "readable"),
	...each(
		[
			"syntaxComment",
			"syntaxKeyword",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxString",
			"syntaxNumber",
			"syntaxType",
			"syntaxOperator",
			"syntaxPunctuation",
		],
		["background", ...MESSAGE_PANELS, ...TOOL_PANELS],
		"readable",
	),
	{ token: "searchMatchText", on: ["searchMatchBg"], level: "readable" },
	...each(["bashMode", "border", "borderAccent"], ["background"], "readable"),
	{ token: "borderMuted", on: ["background"], level: "subtle" },
	...each(["mdQuoteBorder", "mdHr"], ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], "readable"),
	{ token: "scrollbarTrack", on: ["background"], level: "track" },
	{ token: "scrollbarThumb", on: ["scrollbarTrack"], level: "thumb" },
	...THINKING.map((token, index): Rule => ({ token, on: ["background"], level: THINKING_LEVELS[index] })),
];

/** Relaxation compresses levels stronger than this one toward it before weakening all levels. */
export const READABLE_FLOOR: Record<ThemeAppearance, Level> = { dark: "readable", light: "subtle" };

/** Body text uses the terminal's foreground when it reaches this level, which is clearly stronger than muted. */
export const FOREGROUND_LEVEL: Level = "emphasis";

/** Text-level tokens that take the terminal's foreground. */
export const FOREGROUND_TOKENS: ThemeColor[] = ["text", "userMessageText", "toolTitle"];

/** WCAG 2 contrast ratio that body text must reach on the surfaces it is drawn on. */
export const TEXT_MINIMUM_WCAG_CONTRAST = 4.5;

/** Tokens in dependency order: every surface before the tokens drawn on it. */
export const SOLVE_ORDER: ThemeToken[] = (() => {
	const order: ThemeToken[] = [];
	const visit = (token: ThemeToken): void => {
		if (order.includes(token)) return;
		for (const rule of RULES) {
			if (rule.token !== token) continue;
			for (const surface of rule.on) if (surface !== "background") visit(surface);
		}
		order.push(token);
	};
	for (const rule of RULES) visit(rule.token);
	return order;
})();
