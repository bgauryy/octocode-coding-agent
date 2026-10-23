import {
	type RefObject,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { hashFor, type Params, parseHash, type Route } from "./model/route.ts";

function subscribeHash(onChange: () => void): () => void {
	window.addEventListener("hashchange", onChange);
	return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => location.hash;

/** The current hash route. Filter edits use `replaceHash`, which deliberately does not notify subscribers. */
export function useHashRoute(): Route {
	const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
	return parseHash(hash);
}

export function navigate(hash: string): void {
	if (location.hash !== hash) location.hash = hash;
}

/** Keep the hash in step with in-view filters without adding history entries or remounting the view. */
export function replaceHash(name: string, params: Params): void {
	try {
		history.replaceState(null, "", hashFor(name, params));
	} catch {
		// A browser that refuses: the page still works, the hash just does not follow.
	}
}

function isTypingTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
	);
}

interface Hotkey {
	key: string;
	/** ⌘ on macOS, Ctrl elsewhere. */
	mod?: boolean;
	/** Also fire while focus is in a text field. */
	allowInInput?: boolean;
	run: (event: KeyboardEvent) => void;
}
export function useHotkeys(hotkeys: readonly Hotkey[], enabled = true): void {
	const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
		if (event.defaultPrevented || event.isComposing) return;
		for (const hotkey of hotkeys) {
			const mod = event.metaKey || event.ctrlKey;
			if (event.key.toLowerCase() !== hotkey.key.toLowerCase() || Boolean(hotkey.mod) !== mod || event.altKey) continue;
			if (!hotkey.allowInInput && isTypingTarget(event.target)) continue;
			event.preventDefault();
			hotkey.run(event);
			return;
		}
	});
	useEffect(() => {
		if (!enabled) return;
		const listener = (event: KeyboardEvent) => onKeyDown(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, [enabled]);
}

type CopyState = "idle" | "copied" | "failed";
export function useCopy(text: string): [CopyState, () => Promise<void>] {
	const [state, setState] = useState<CopyState>("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback(async () => {
		clearTimeout(timer.current);
		try {
			await navigator.clipboard.writeText(text);
			setState("copied");
			timer.current = setTimeout(() => setState("idle"), 2000);
		} catch {
			setState("failed");
		}
	}, [text]);
	return [state, copy];
}

const FOCUSABLE = "a[href], button, summary, input, select, textarea, [tabindex]";
function focusable(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(element) =>
			!(element as HTMLButtonElement).disabled &&
			element.tabIndex >= 0 &&
			!element.closest("[inert]") &&
			element.getClientRects().length > 0,
	);
}

/** Open modals, innermost last: only the innermost one handles Escape and Tab. */
const modals: symbol[] = [];
export function hasOpenModal(): boolean {
	return modals.length > 0;
}

/**
 * Modal behavior for a dialog that is not a native `<dialog>` (jsdom and older engines lack `showModal`): Tab and Shift+Tab wrap inside it, Escape closes it,
 * the page behind stops scrolling, and focus returns to the opener when it closes.
 */
export function useModal(
	container: RefObject<HTMLElement | null>,
	onClose: () => void,
	initialFocus?: () => HTMLElement | null,
) {
	const close = useEffectEvent(onClose);
	const focusInitial = useEffectEvent(() => (initialFocus?.() ?? container.current)?.focus({ preventScroll: true }));
	useLayoutEffect(() => {
		const token = Symbol("modal");
		modals.push(token);
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		focusInitial();
		function onKeyDown(event: KeyboardEvent) {
			const root = container.current;
			if (!root || modals.at(-1) !== token) return;
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = focusable(root);
			if (!controls.length) {
				event.preventDefault();
				return;
			}
			const first = controls[0];
			const last = controls[controls.length - 1];
			const active = document.activeElement;
			const outside = !(active instanceof Node) || !root.contains(active) || !controls.includes(active as HTMLElement);
			if (event.shiftKey && (active === first || outside)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (active === last || outside)) {
				event.preventDefault();
				first.focus();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => {
			modals.splice(modals.indexOf(token), 1);
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = overflow;
			if (opener?.isConnected) opener.focus({ preventScroll: true });
		};
	}, [container]);
}

/** Milliseconds since `since`, ticking once a second while `active`. */
export function useElapsed(since: number, active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return Math.max(0, now - since);
}

const BOTTOM_SLACK = 32;
/**
 * Keep a scrolling log pinned to its newest line while the reader is at the bottom; scrolling up releases it, and
 * `jump` returns to the end. `content` is whatever changes when new lines arrive.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, content: unknown) {
	const [atBottom, setAtBottom] = useState(true);
	const pinned = useRef(true);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const onScroll = () => {
			pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
			setAtBottom(pinned.current);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, [ref]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever new content arrives.
	useLayoutEffect(() => {
		const element = ref.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [ref, content]);
	const jump = useCallback(() => {
		const element = ref.current;
		if (!element) return;
		pinned.current = true;
		setAtBottom(true);
		element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [ref]);
	return { atBottom, jump };
}
