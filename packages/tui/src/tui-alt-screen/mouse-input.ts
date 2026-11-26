import type { TuiMouseButton } from "../tui.ts";
import type { SgrMouseEvent, WheelEvent } from "./types.ts";

export function decodeMouseButton(button: number): TuiMouseButton {
	switch (button & 3) {
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return "none";
	}
}

export function parseWheelEvent(data: string): WheelEvent | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return {
			direction: direction === 0 ? -1 : 1,
			x: Number.parseInt(sgr[2], 10) - 1,
			y: Number.parseInt(sgr[3], 10) - 1,
			button,
		};
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return {
			direction: direction === 0 ? -1 : 1,
			x: data.charCodeAt(4) - 33,
			y: data.charCodeAt(5) - 33,
			button,
		};
	}
	return undefined;
}

/** A button press, release or drag; wheel codes (bit 64, horizontal ones too) are not buttons and give undefined. */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	const button = Number.parseInt(match[1], 10);
	if ((button & 64) !== 0) return undefined;
	return {
		button,
		x: Number.parseInt(match[2], 10) - 1,
		y: Number.parseInt(match[3], 10) - 1,
		release: match[4] === "m",
	};
}

export function isMouseSequence(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
}
