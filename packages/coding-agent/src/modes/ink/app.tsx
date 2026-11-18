import {
	FullscreenFrame,
	type InkScreen,
	type InkTheme,
	type InkTui,
	InlineFrame,
	Text,
	ThemeProvider,
	useTheme,
} from "@octocodeai/octocode-tui-ink";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { ThemeColor } from "../../theme/theme-tokens.ts";
import { selectHideThinking, selectNotice, selectToolsExpanded } from "../interactive/state/view-slice.ts";
import type { UiStore } from "../interactive/state/store.ts";

export interface InkAppProps {
	readonly tui: InkTui;
	readonly store: UiStore;
	readonly screen: InkScreen;
	readonly theme: InkTheme<ThemeColor>;
}

/** One status line read from the interactive store; the full footer arrives with its own port. */
function FooterLine({ store, screen }: { store: UiStore; screen: InkScreen }): ReactNode {
	const theme = useTheme<ThemeColor>();
	const toolsExpanded = useStore(store, selectToolsExpanded);
	const hideThinking = useStore(store, selectHideThinking);
	const notice = useStore(store, selectNotice);
	const parts = [
		`ink ${screen}`,
		toolsExpanded ? "tools expanded" : "tools collapsed",
		hideThinking ? "thinking hidden" : "thinking shown",
		...(notice ? [notice.text] : []),
	];
	return <Text wrap="truncate-end">{theme.fg("dim", parts.join(" · "))}</Text>;
}

/** The old transcript, editor and footer through the legacy bridge, with one new footer line under them. */
export function InkApp({ tui, store, screen, theme }: InkAppProps): ReactNode {
	const footer = <FooterLine store={store} screen={screen} />;
	const Frame = screen === "fullscreen" ? FullscreenFrame : InlineFrame;
	return (
		<ThemeProvider theme={theme}>
			<Frame component={tui.frame} signal={tui.signal} footer={footer} footerRows={1} />
		</ThemeProvider>
	);
}
