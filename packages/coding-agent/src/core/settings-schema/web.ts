import { Type } from "typebox";

/** The `web` settings of the root schema. */
export const WebSettingsProperties = {
	web: Type.Optional(
		Type.Object(
			{
				sound: Type.Optional(
					Type.Boolean({
						description:
							"Play a short chime with a web workspace notification (an approval or question waiting, a run finished or failed). The page makes the sound; the toggle in the workspace changes this setting. Notifications themselves need the browser's permission, which the page asks for from its own control.",
						default: false,
					}),
				),
				theme: Type.Optional(
					Type.Union([Type.Literal("system"), Type.Literal("light"), Type.Literal("dark")], {
						description:
							'Colour theme of the web workspace: "system" follows the operating system, "light" and "dark" override it. The theme control in the workspace changes this setting.',
						default: "system",
					}),
				),
				window: Type.Optional(
					Type.Union([Type.Literal("app"), Type.Literal("browser")], {
						description:
							'Where /web opens the workspace: "app" is a Chrome, Edge, Chromium or Brave app window with a temporary profile apart from your own (no extensions, cookies or history; removed when it closes); "browser" uses the default browser. Without an installed Chromium browser "app" falls back to the default browser. Applies to the next /web.',
						default: "app",
					}),
				),
			},
			{ additionalProperties: false },
		),
	),
};
