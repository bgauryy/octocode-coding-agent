import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "../shared/util.ts";
import { abortError } from "./abort.ts";
import type { BrowserSession } from "./cdp.ts";
import { pressKey } from "./input/keyboard.ts";

export { pressKey } from "./input/keyboard.ts";
export { settle, settleAfterLoad, waitForText } from "./input/settle.ts";

type Page = BrowserSession["page"];

/** The element numbered `ref` by the last snapshot, while it is still in the page. */
export const elementExpr = (ref: number) =>
	`(() => { const el = (window.__octoRefs || [])[${ref - 1}]; return el && el.isConnected ? el : null; })()`;

interface Point {
	x: number;
	y: number;
	/** The element on top at that point when it is not the target (a banner or overlay the mouse would hit instead). */
	covered: string;
}

/**
 * Scrolls `[ref]` into view and returns its centre in main-frame viewport coordinates (frame offsets added), or
 * `hidden` for an element with no box. Measuring never changes the target or activates it.
 */
async function pointOf(
	page: Page,
	ref: number,
	signal: AbortSignal | undefined,
	options: { block?: "center" | "nearest" } = {},
): Promise<Point | "hidden"> {
	const point = await page.evaluate<Point | null | "hidden">(
		`(() => {
      const el = ${elementExpr(ref)};
      if (!el) return null;
      el.scrollIntoView({ block: '${options.block ?? "center"}', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return 'hidden';
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = el.getRootNode().elementFromPoint ? el.getRootNode().elementFromPoint(cx, cy) : null;
      const covered = !hit ? 'No element at the target point' : hit !== el && !el.contains(hit) ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + ' "' + String(hit.innerText || '').trim().slice(0, 40) + '"' : '';
      let x = cx, y = cy;
      for (let w = el.ownerDocument.defaultView; w && w.frameElement; w = w.parent) { const f = w.frameElement.getBoundingClientRect(); x += f.left + w.frameElement.clientLeft; y += f.top + w.frameElement.clientTop; }
      return { x, y, covered };
    })()`,
		signal,
	);
	if (point === null) throw new Error(`No element [${ref}] — take a new snapshot.`);
	return point;
}

const mouse = (
	page: Page,
	type: string,
	at: { x: number; y: number },
	extra: Record<string, unknown>,
	signal?: AbortSignal,
) => page.send("Input.dispatchMouseEvent", { type, ...at, ...extra }, signal);

/**
 * Moves the mouse onto `[ref]` and returns where it ended up. Moving can shift the layout (a hover menu elsewhere
 * closes, a sticky header appears), so the element is measured again after the move and the mouse follows it.
 */
async function approach(
	page: Page,
	ref: number,
	signal: AbortSignal | undefined,
	options: { block?: "center" | "nearest" } = {},
): Promise<Point | "hidden"> {
	const first = await pointOf(page, ref, signal, options);
	if (first === "hidden") return first;
	await mouse(page, "mouseMoved", first, { button: "none", buttons: 0 }, signal);
	const settled = await pointOf(page, ref, signal, { block: "nearest" });
	if (settled === "hidden") return settled;
	if (Math.abs(settled.x - first.x) > 1 || Math.abs(settled.y - first.y) > 1)
		await mouse(page, "mouseMoved", settled, { button: "none", buttons: 0 }, signal);
	return settled;
}

/**
 * Clicks `[ref]` the way a user does: a real mouse press and release at its centre (trusted events, so
 * mousedown/pointerdown handlers run). Refuses hidden or covered targets before pressing the mouse.
 */
export async function click(page: Page, ref: number, signal?: AbortSignal): Promise<string> {
	const point = await approach(page, ref, signal);
	if (point === "hidden") throw new Error(`[${ref}] has no visible box to click.`);
	if (point.covered) throw new Error(`${point.covered} covers [${ref}]; click was refused.`);
	let released = false;
	try {
		await mouse(page, "mousePressed", point, { button: "left", buttons: 1, clickCount: 1 }, signal);
		await mouse(page, "mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 }, signal);
		released = true;
	} finally {
		if (!released)
			await mouse(page, "mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
	}
	if (signal?.aborted) throw abortError(signal);
	return "";
}

/** Moves the mouse onto `[ref]` with no button held, so hover menus and tooltips open; the next mouse action ends it. */
export async function hover(page: Page, ref: number, signal?: AbortSignal): Promise<string> {
	const point = await approach(page, ref, signal);
	if (point === "hidden") throw new Error(`[${ref}] has no visible box to hover.`);
	return point.covered ? `Note: ${point.covered} covers [${ref}], so the mouse is over it instead.` : "";
}

/** Mouse moves between press and release, so pointer-based drag libraries see a real path. */
const DRAG_STEPS = 6;
const DRAG_STEP_MS = 16;
/** Longest wait for Chrome to report an HTML5 drag after the moves. */
const DRAG_INTERCEPT_WAIT_MS = 500;

/**
 * Numbers, as the last element of `window.__octoRefs`, the smallest visible element whose text contains `text` (a drop
 * zone the snapshot does not list because it has no role or handler attribute); throws when there is none.
 */
export async function refForText(page: Page, text: string, signal?: AbortSignal): Promise<number> {
	const ref = await page.evaluate<number | null>(
		`(() => {
      const want = ${JSON.stringify(text.trim().toLowerCase())};
      let best = null;
      for (const el of document.body ? document.body.querySelectorAll('*') : []) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || !String(el.innerText || '').toLowerCase().includes(want)) continue;
        if (!best || r.width * r.height < best.area) best = { el, area: r.width * r.height };
      }
      if (!best) return null;
      const refs = window.__octoRefs || (window.__octoRefs = []);
      if (best.el.__octoRef && refs[best.el.__octoRef - 1] === best.el) return best.el.__octoRef;
      refs.push(best.el);
      best.el.__octoRef = refs.length;
      return refs.length;
    })()`,
		signal,
	);
	if (ref === null) throw new Error(`No visible element contains ${JSON.stringify(text)}.`);
	return ref;
}

/**
 * Drags `[from]` onto `[to]`. The mouse is pressed on the source and moved in steps; with drag interception on, an
 * HTML5 drag (draggable elements, dataTransfer) is reported by Chrome and finished with dragEnter/dragOver/drop at the
 * target, while a pointer-based drag (mousedown/mousemove/mouseup libraries) just gets the moves and the release.
 */
export async function drag(page: Page, from: number, to: number, signal?: AbortSignal): Promise<string> {
	const start = await approach(page, from, signal);
	if (start === "hidden") throw new Error(`[${from}] has no visible box to drag.`);
	const end = await pointOf(page, to, signal, { block: "nearest" });
	if (end === "hidden") throw new Error(`[${to}] has no visible box to drop on.`);
	if (start.covered) throw new Error(`${start.covered} covers [${from}]; drag was refused.`);
	if (end.covered) throw new Error(`${end.covered} covers [${to}]; drag was refused.`);
	let pressed = false;
	let released = false;
	let data: unknown;
	let intercepted: (() => void) | undefined;
	const off = page.on((method, params) => {
		if (method !== "Input.dragIntercepted") return;
		data = params.data;
		intercepted?.();
	});
	try {
		await page.send("Input.setInterceptDrags", { enabled: true }, signal);
		pressed = true;
		await mouse(page, "mousePressed", start, { button: "left", buttons: 1, clickCount: 1 }, signal);
		for (let step = 1; step <= DRAG_STEPS; step++) {
			const at = {
				x: start.x + ((end.x - start.x) * step) / DRAG_STEPS,
				y: start.y + ((end.y - start.y) * step) / DRAG_STEPS,
			};
			await mouse(page, "mouseMoved", at, { button: "left", buttons: 1 }, signal);
			// Paced like a hand: Chrome starts an HTML5 drag (and reports it) only across separate frames.
			await sleep(DRAG_STEP_MS, undefined, signal ? { signal } : undefined);
		}
		// An HTML5 drag is reported shortly after the moves; a pointer drag never is.
		if (data === undefined)
			await new Promise<void>((resolve) => {
				intercepted = resolve;
				return setTimeout(resolve, DRAG_INTERCEPT_WAIT_MS);
			});
		if (data !== undefined) {
			for (const type of ["dragEnter", "dragOver", "drop"])
				await page.send("Input.dispatchDragEvent", { type, ...end, data, modifiers: 0 }, signal);
		}
		await mouse(page, "mouseReleased", end, { button: "left", buttons: 0, clickCount: 1 }, signal);
		released = true;
	} finally {
		off();
		await page.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
		if (pressed && !released)
			await mouse(page, "mouseReleased", end, { button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
	}
	if (signal?.aborted) throw abortError(signal);
	const kind = data !== undefined ? "an HTML5 drag" : "a mouse drag";
	return `Dragged [${from}] onto [${to}] (${kind}).${end.covered ? ` Note: ${end.covered} covers [${to}].` : ""}`;
}

/**
 * Prepares `[ref]` for typed text and says how: `select` (the option was picked here), `field`/`editable` (existing text
 * selected, so the typed text replaces it), `no-focus` (focus did not land on a text field, so typing would go elsewhere),
 * `no-option:<labels>`, or null when the element is gone.
 */
function focusForTyping(ref: number, text: string): string {
	return `(() => {
    const el = ${elementExpr(ref)};
    if (!el) return null;
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return 'no-focus';
    if (el.tagName === 'SELECT') {
      const want = ${JSON.stringify(text)}.trim().toLowerCase();
      const options = [...el.options];
      if (!want) return 'no-option:' + options.map((o) => o.label.trim()).join(' | ');
      const option = options.find((o) => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want) || options.find((o) => o.label.toLowerCase().includes(want));
      if (!option || option.disabled || option.parentElement?.disabled) return 'no-option:' + options.map((o) => o.label.trim()).join(' | ');
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'select';
    }
    el.scrollIntoView({ block: 'center' });
    el.focus();
    let active = el.ownerDocument.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (active !== el && !(active && el.contains(active))) return 'no-focus';
    const field = active || el;
    if (field.isContentEditable) { field.ownerDocument.getSelection().selectAllChildren(field); return 'editable'; }
    if (field.tagName !== 'TEXTAREA' && !(field.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(field.type))) return 'no-focus';
    try { field.select(); } catch { field.value = ''; }
    return 'field';
  })()`;
}

/**
 * Types `text` into `[ref]`, replacing what is there (a `<select>` gets the option with that label or value), then
 * presses Enter when `submit`. Refused, with the reason, when the element is gone, has no such option, or focus does
 * not land on a text field (the text would go elsewhere).
 */
export async function typeInto(
	page: Page,
	ref: number,
	text: string,
	submit: boolean,
	signal?: AbortSignal,
): Promise<void> {
	const target = await page.evaluate<string | null>(focusForTyping(ref, text), signal);
	if (target === null) throw new Error(`No element [${ref}] — take a new snapshot.`);
	if (target.startsWith("no-option:"))
		throw new Error(`[${ref}] has no option "${text}". Options: ${target.slice("no-option:".length)}`);
	if (target === "no-focus")
		throw new Error(
			`[${ref}] is not a text field, so typing was refused (it would land elsewhere); click it, or type into the input it opens.`,
		);
	if (target !== "select") await page.send("Input.insertText", { text }, signal);
	const matches = await page.evaluate<boolean>(
		`(() => {
      const el = ${elementExpr(ref)};
      if (!el) return false;
      const want = ${JSON.stringify(text)};
      if (el.tagName === 'SELECT') {
        const normalized = want.trim().toLowerCase();
        const options = [...el.options];
        const option = options.find((o) => o.label.trim().toLowerCase() === normalized || o.value.toLowerCase() === normalized) || options.find((o) => o.label.toLowerCase().includes(normalized));
        return !!option && option.selected;
      }
      return (el.isContentEditable ? el.innerText : el.value) === want;
    })()`,
		signal,
	);
	if (!matches) throw new Error(`[${ref}] did not retain the requested value; inspect the field before retrying.`);
	if (submit) await pressKey(page, "Enter", signal);
}

/** Checkbox-like state of `[ref]`: `checked`/`unchecked`, `text` for anything else, or null when it is gone. */
const toggleState = (ref: number) => `(() => {
  const el = ${elementExpr(ref)};
  if (!el) return null;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) return el.checked ? 'checked' : 'unchecked';
  const role = el.getAttribute('role');
  if (role === 'checkbox' || role === 'switch' || role === 'radio') return el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked';
  return 'text';
})()`;

/**
 * Fills several fields in one call: text fields and `<select>`s through `typeInto`; checkboxes, radios and switches are
 * clicked only when their state differs from the value (`true`/`false`). Every field is tried; returns one line per
 * field that failed (empty when all succeeded).
 */
export async function fillFields(
	page: Page,
	fields: ReadonlyArray<{ ref: number; value: string }>,
	signal?: AbortSignal,
): Promise<string[]> {
	const failures: string[] = [];
	for (const { ref, value } of fields) {
		try {
			const state = await page.evaluate<string | null>(toggleState(ref), signal);
			if (state === null) throw new Error(`No element [${ref}] — take a new snapshot.`);
			if (state === "text") await typeInto(page, ref, value, false, signal);
			else {
				if (!/^(true|yes|on|1|checked|false|no|off|0|unchecked)$/i.test(value.trim()))
					throw new Error("Toggle value must be true or false.");
				const wanted = /^(true|yes|on|1|checked)$/i.test(value.trim()) ? "checked" : "unchecked";
				if (state !== wanted) await click(page, ref, signal);
				if ((await page.evaluate<string | null>(toggleState(ref), signal)) !== wanted)
					throw new Error(`Toggle did not become ${wanted}; inspect the field before retrying.`);
			}
		} catch (error) {
			if (signal?.aborted) throw abortError(signal);
			failures.push(`[${ref}]: ${errorMessage(error)}`);
		}
	}
	return failures;
}
