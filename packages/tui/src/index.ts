// Core TUI interfaces and classes

export { Marked, type Token, type Tokens } from "marked";
// Autocomplete support
export type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	SlashCommand,
} from "./autocomplete/types.ts";
export { CombinedAutocompleteProvider } from "./autocomplete.ts";
// Colors and styling
export {
	backgroundAnsi,
	type Color,
	type ColorMixSpace,
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	foregroundAnsi,
	type IndexedColor,
	indexedColor,
	mixColors,
	type OkhslChannels,
	type OklchChannels,
	type OklchColorValue,
	okhslColor,
	oklchColor,
	parseColor,
	type RgbColorValue,
	rgbColor,
	styleText,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TextAttributes,
	type TextStyle,
} from "./colors.ts";
export { type ShimmerOptions, shimmerText } from "./shimmer.ts";
// Design tokens and the shared animation clock
export { type AnimationClock, type AnimationKind, type AnimationSubscription, animationClock } from "./tokens/clock.ts";
export { breathe, ELLIPSIS, GLYPH, MOTION, SEPARATOR, SPINNER, settle, type UiState } from "./tokens/design.ts";
// State binding: views follow a selection of a state source
export {
	Connected,
	type ConnectedOptions,
	type Equality,
	shallowEqual,
	type StateSource,
	watchSelection,
} from "./state-source.ts";
// Components
export { Box } from "./components/box.ts";
export { CancellableLoader } from "./components/cancellable-loader.ts";
export type { EditorBorderDecorator, EditorOptions, EditorTheme } from "./components/editor/types.ts";
export { Editor } from "./components/editor.ts";
export { HStack } from "./components/h-stack.ts";
export {
	Image,
	type ImageOptions,
	type ImageTheme,
	type ImageTranscoder,
	setImageTranscoder,
} from "./components/image.ts";
export { Input } from "./components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
export type { DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "./components/markdown/types.ts";
export { Markdown } from "./components/markdown.ts";
export {
	markdownReferences,
	markdownReferenceUrl,
	markdownPlainText,
	markdownCodeBlocks,
	type MarkdownReference,
} from "./markdown-content.ts";
export { MouseRegion, type MouseRegionHandler } from "./components/mouse-region.ts";
export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "./components/scroll-view.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
export { fitRows, type RowColumn, type RowFit, type RowFitOptions } from "./components/row-fit.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./components/stack.ts";
export { VStack } from "./components/v-stack.ts";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.ts";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// Keybindings
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";
// Keyboard input handling
export { matchesKey } from "./keys/match.ts";
export { Key, type KeyId } from "./keys/key-id.ts";
export { isKittyProtocolActive, setKittyProtocolActive } from "./keys/state.ts";
export { isKeyRelease, isKeyRepeat, type KeyEventType } from "./keys/sequences.ts";
export { decodeKittyPrintable, parseKey } from "./keys/parse.ts";
export { splitDoubleEscape } from "./keys/double-escape.ts";
// LaTeX rendering
export { type RenderLatexOptions, renderLatex } from "./latex.ts";
// Native platform integration
export { getNativeClipboard, type NativeClipboard } from "./native-platform.ts";
export { oklabToOkhslLightness } from "./oklab.ts";
// Terminal multiplexer detection and tmux queries
export {
	detectMultiplexer,
	hasTmuxSession,
	type MultiplexerId,
	paneTarget,
	resetMultiplexerCache,
	type TmuxExecOptions,
	tmuxClientTermFeatures,
	tmuxClientTerminalNames,
	tmuxExec,
	tmuxGlobalOption,
	tmuxPaneAllowsPassthrough,
	wrapTmuxPassthrough,
} from "./multiplexer.ts";
// Program status reporting (OSC 7501)
export { formatProgramStatus, type ProgramStatus } from "./program-status.ts";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// Terminal interface and implementations
export { isAppleTerminalSession, type OutputTelemetry, ProcessTerminal, type Terminal } from "./terminal.ts";
// Terminal colors
export {
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
// Terminal image support
export {
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
} from "./terminal-image/dimensions.ts";
export {
	detectCapabilities,
	getCapabilities,
	getCellDimensions,
	getTerminalColorMode,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
} from "./terminal-image/capabilities.ts";
export type {
	CellDimensions,
	ImageDimensions,
	ImageProtocol,
	ImageRenderOptions,
	TerminalCapabilities,
} from "./terminal-image/types.ts";
export {
	allocateImageId,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	encodeITerm2,
	encodeKitty,
	hyperlink,
	imageFallback,
	renderImage,
} from "./terminal-image.ts";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	type OverlayAnchor,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	renderFakeCursor,
	computeRenderDelayMs,
	type RenderErrorListener,
	type RenderPacingOptions,
	type RenderPacingStats,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
	type TuiStopOptions,
	type ViewportTUI,
} from "./tui.ts";
export type { TuiAltScreenOptions } from "./tui-alt-screen/types.ts";
export { TuiAltScreen } from "./tui-alt-screen.ts";
export type { TuiMainScreenRenderState } from "./tui-main-screen/render-diff.ts";
export { TuiMainScreen } from "./tui-main-screen.ts";
// Utilities
export { wrapTextWithAnsi } from "./utils/wrap.ts";
export { visibleWidth } from "./utils/width.ts";
export { truncateToWidth } from "./utils/truncate.ts";
export { closeOpenStyles } from "./utils/ansi-tracker.ts";
export { getOsc8LinkAtColumn, sliceByColumn } from "./utils/columns.ts";
export { stripTerminalSequences } from "./utils.ts";
export { type VisualTruncateResult, VisualLinePreview, truncateToVisualLines } from "./components/visual-truncate.ts";
export { incompleteAnsiStart } from "./utils/ansi-codes.ts";
export type { WheelScrollLines } from "./wheel-scroll.ts";
