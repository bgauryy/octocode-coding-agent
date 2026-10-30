import type { TerminalColorMode } from "../colors.ts";
import {
	detectMultiplexer,
	hasTmuxSession,
	tmuxClientTermFeatures,
	tmuxClientTerminalNames,
	tmuxPaneAllowsPassthrough,
} from "../multiplexer.ts";
import type { CellDimensions, ImageProtocol, TerminalCapabilities } from "./types.ts";

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};
let probedImageProtocol: ImageProtocol | undefined;

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/**
 * Whether the attached tmux client forwards OSC 8 hyperlinks to the outer terminal. tmux only re-emits them when its
 * `client_termfeatures` lists `hyperlinks`, and strips them otherwise. A failed query counts as `false`.
 */
function probeTmuxHyperlinks(): boolean {
	return tmuxClientTermFeatures().includes("hyperlinks");
}

/** Outer terminals known to draw Kitty Unicode placeholders. WezTerm and Warp lack them, so they stay off. */
const PLACEHOLDER_TERMINALS = new Set(["kitty", "ghostty"]);

/**
 * Kitty images under tmux need three things: a client that draws Unicode placeholders, a pane that lets the DCS
 * passthrough envelope through, and 24-bit colour, because the image id travels in the foreground colour.
 */
function detectTmuxKittyImages(hasTrueColorHint: boolean): ImageProtocol {
	if (!hasTmuxSession()) return null;
	if (!tmuxClientTerminalNames().some((name) => PLACEHOLDER_TERMINALS.has(name.replace(/^xterm-/, "")))) return null;
	if (!tmuxPaneAllowsPassthrough()) return null;
	return hasTrueColorHint || tmuxClientTermFeatures().includes("RGB") ? "kitty" : null;
}

function detectCapabilitiesFromEnvironment(tmuxForwardsHyperlink: () => boolean): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct");
	const isWindowsConsole = process.platform === "win32";

	// Emit OSC 8 hyperlinks only when tmux confirms it forwards.
	// Kitty images under tmux go through passthrough with Unicode placeholders; other protocols stay off.
	const multiplexer = detectMultiplexer();
	if (multiplexer === "tmux") {
		return {
			images: detectTmuxKittyImages(hasTrueColorHint),
			trueColor: hasTrueColorHint,
			hyperlinks: tmuxForwardsHyperlink(),
		};
	}

	// screen does not forward OSC 8 hyperlinks, so keep them off there.
	if (multiplexer === "screen") {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	// Herdr forwards OSC 8 hyperlinks and supports the Kitty graphics protocol. Check it before
	// outer-terminal detection because variables like KITTY_WINDOW_ID can leak into its panes.
	if (termProgram === "herdr") {
		return { images: "kitty", trueColor: hasTrueColorHint, hyperlinks: true };
	}

	// Rex supports OSC 8 hyperlinks but only partially implements the Kitty graphics protocol
	// (no Unicode placeholders), so leave images off. Check it before outer-terminal detection.
	if (termProgram === "rex") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty" || term === "xterm-kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Warp supports the Kitty graphics protocol and OSC 8 hyperlinks.
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	if (isWindowsConsole) {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

function imageProtocolOverride(): ImageProtocol | undefined {
	const protocol = process.env.OCTOCODE_IMAGE_PROTOCOL?.toLowerCase();
	return protocol === "kitty" || protocol === "iterm2"
		? protocol
		: protocol === "none" || protocol === "0"
			? null
			: undefined;
}

/** Probe only automatic graphics detection; multiplexers and partial implementations stay conservative. */
export function shouldProbeKittyGraphics(): boolean {
	if (capabilityOverrides.images !== undefined || imageProtocolOverride() !== undefined) return false;
	const multiplexer = detectMultiplexer();
	if (multiplexer === "tmux" || multiplexer === "screen") return false;
	if (process.env.TERM_PROGRAM?.toLowerCase() === "rex") return false;
	return detectCapabilitiesFromEnvironment(() => false).images !== "iterm2";
}

/** Apply a terminal reply without overriding explicit configuration or changing unrelated capabilities. */
export function setProbedImageProtocol(protocol: ImageProtocol): boolean {
	if (!shouldProbeKittyGraphics()) return false;
	const previous = getCapabilities().images;
	probedImageProtocol = protocol;
	cachedCapabilities = null;
	return previous !== getCapabilities().images;
}

export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const hyperlinks = parseBooleanCapabilityOverride(process.env.OCTOCODE_HYPERLINKS);
	const detected = detectCapabilitiesFromEnvironment(
		hyperlinks === undefined ? tmuxForwardsHyperlink : () => hyperlinks,
	);
	const images = imageProtocolOverride();
	const trueColor = parseBooleanCapabilityOverride(process.env.OCTOCODE_TRUE_COLOR);
	return {
		...detected,
		...(images !== undefined ? { images } : {}),
		...(trueColor !== undefined ? { trueColor } : {}),
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		const capabilities = {
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			...(probedImageProtocol !== undefined && imageProtocolOverride() === undefined
				? { images: probedImageProtocol }
				: {}),
			...capabilityOverrides,
		};
		// Decided here, not when a sequence is written, so `setCapabilities` in tests never depends on the ambient TMUX.
		cachedCapabilities =
			capabilities.images === "kitty" && hasTmuxSession() ? { ...capabilities, kittyPlaceholders: true } : capabilities;
	}
	return cachedCapabilities;
}

/**
 * Whether Kitty graphics go through tmux passthrough with Unicode placeholders: inside a tmux session whenever the
 * effective image protocol is Kitty, whether detected or forced with `OCTOCODE_IMAGE_PROTOCOL=kitty` or settings.
 */
export function kittyPlaceholderMode(): boolean {
	return getCapabilities().kittyPlaceholders === true;
}

export function getTerminalColorMode(capabilities: TerminalCapabilities = getCapabilities()): TerminalColorMode {
	return capabilities.trueColor ? "truecolor" : "256color";
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
	probedImageProtocol = undefined;
}

/** Override selected auto-detected capabilities. */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	if (
		capabilityOverrides.images === overrides.images &&
		capabilityOverrides.trueColor === overrides.trueColor &&
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		return;
	}
	capabilityOverrides = { ...overrides };
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}
