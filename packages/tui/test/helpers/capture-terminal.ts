import type { IBufferCell } from "@xterm/headless";
import xterm from "@xterm/headless";
import { colorToRgb, parseColor, type Terminal } from "../../src/index.ts";

export interface QaCell {
	chars: string;
	width: number;
	fg: number | null;
	bg: number | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
}
const color = (cell: IBufferCell, foreground: boolean): number | null => {
	const value = foreground ? cell.getFgColor() : cell.getBgColor();
	if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return value;
	if (!(foreground ? cell.isFgPalette() : cell.isBgPalette())) return null;
	const rgb = colorToRgb(parseColor(value));
	return (rgb.r << 16) | (rgb.g << 8) | rgb.b;
};

/** Production escape sequences flow through xterm; no provider, database, or OS terminal is started. */
export class QaTerminal implements Terminal {
	readonly emulator: InstanceType<typeof xterm.Terminal>;
	readonly kittyProtocolActive = false;
	readonly writes: string[] = [];
	readonly columns: number;
	readonly rows: number;
	constructor(columns: number, rows = 24) {
		this.columns = columns;
		this.rows = rows;
		this.emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, disableStdin: true });
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
		this.emulator.write(data);
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[0J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	async flush(): Promise<void> {
		await new Promise<void>((done) => this.emulator.write("", done));
	}
	capture(): { text: string[]; cells: QaCell[][] } {
		const buffer = this.emulator.buffer.active;
		const text: string[] = [];
		const cells: QaCell[][] = [];
		for (let row = 0; row < this.rows; row++) {
			const line = buffer.getLine(buffer.viewportY + row);
			text.push(line?.translateToString(true) ?? "");
			cells.push(
				Array.from({ length: this.columns }, (_, column): QaCell => {
					const cell = line?.getCell(column);
					if (!cell)
						return {
							chars: "",
							width: 1,
							fg: null,
							bg: null,
							bold: false,
							dim: false,
							italic: false,
							underline: false,
							inverse: false,
						};
					return {
						chars: cell.getChars(),
						width: cell.getWidth(),
						fg: color(cell, true),
						bg: color(cell, false),
						bold: !!cell.isBold(),
						dim: !!cell.isDim(),
						italic: !!cell.isItalic(),
						underline: !!cell.isUnderline(),
						inverse: !!cell.isInverse(),
					};
				}),
			);
		}
		return { text, cells };
	}
}
