import { formatScript, formatUnicodeScript, normalizeOutput } from "./format.ts";
import { LAYOUT_MARKER_END, LAYOUT_MARKER_START, type LayoutNode } from "./layout.ts";

/**
 * Parser state and the argument, script and operator readers shared by every LaTeX construct.
 * The concrete parser supplies sequence, command and nested parsing.
 */
export abstract class LatexParserBase {
	protected readonly source: string;
	protected readonly layoutNodes: LayoutNode[];
	protected readonly display: boolean;
	protected position = 0;
	protected supported = true;
	protected stackFractions = true;
	protected scriptDepth = 0;

	constructor(source: string, layoutNodes: LayoutNode[], display: boolean) {
		this.source = source;
		this.layoutNodes = layoutNodes;
		this.display = display;
	}

	/** Parse until `endCharacter`, which is consumed, or the end of the source. */
	protected abstract parseSequence(endCharacter?: string): string;

	/** Parse the command after a backslash. */
	protected abstract parseCommand(): string;

	/** Render a nested source into the shared layout nodes; marks this parse unsupported when that fails. */
	protected abstract renderNested(source: string, stackFractions?: boolean): string;

	protected parseScripts(initialMarker: "^" | "_"): string {
		const scripts: { sub?: string; sup?: string } = {};
		const order: Array<"sub" | "sup"> = [];
		const parse = (marker: "^" | "_"): void => {
			const kind = marker === "_" ? "sub" : "sup";
			this.scriptDepth++;
			try {
				scripts[kind] = this.parseRequiredArgument(false);
			} finally {
				this.scriptDepth--;
			}
			order.push(kind);
		};

		parse(initialMarker);
		let nextPosition = this.position;
		while (nextPosition < this.source.length && /\s/.test(this.source[nextPosition] ?? "")) {
			nextPosition++;
		}
		const nextMarker = this.source[nextPosition];
		if ((nextMarker === "^" || nextMarker === "_") && nextMarker !== initialMarker) {
			this.position = nextPosition + 1;
			parse(nextMarker);
		}

		const subUnicode = scripts.sub === undefined ? undefined : formatUnicodeScript(scripts.sub, "sub");
		const supUnicode = scripts.sup === undefined ? undefined : formatUnicodeScript(scripts.sup, "sup");
		const canUseLayout = ![scripts.sub, scripts.sup].some(
			(value) =>
				value !== undefined &&
				(value.includes("/") ||
					(!value.includes(LAYOUT_MARKER_START) && Array.from(value).length > 1 && !/[A-Z*∗]/.test(value))),
		);
		const needsLayout =
			this.display &&
			canUseLayout &&
			(this.scriptDepth > 0 ||
				(scripts.sub !== undefined && subUnicode === undefined) ||
				(scripts.sup !== undefined && supUnicode === undefined));
		if (!needsLayout) {
			return order
				.map((kind) =>
					kind === "sub"
						? (subUnicode ?? formatScript(scripts.sub ?? "", kind))
						: (supUnicode ?? formatScript(scripts.sup ?? "", kind)),
				)
				.join("");
		}

		const index =
			this.layoutNodes.push({
				type: "script",
				lower: scripts.sub === undefined ? undefined : normalizeOutput(scripts.sub),
				upper: scripts.sup === undefined ? undefined : normalizeOutput(scripts.sup),
			}) - 1;
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	protected parseWhitespace(): string {
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		return " ";
	}

	protected parseOperator(
		operator: string,
		inlineLowerStyle: "bracket" | "script",
		displayLimits: boolean,
		spaced = false,
	): string {
		let useDisplayLimits = displayLimits;
		let modifierPosition = this.position;
		while (modifierPosition < this.source.length && /[ \t]/.test(this.source[modifierPosition] ?? "")) {
			modifierPosition++;
		}
		const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
		if (modifier) {
			useDisplayLimits = modifier[1] === "limits";
			this.position = modifierPosition + modifier[0].length;
		}

		let lower: string | undefined;
		let upper: string | undefined;
		while (true) {
			let scriptPosition = this.position;
			while (scriptPosition < this.source.length && /[ \t]/.test(this.source[scriptPosition] ?? "")) {
				scriptPosition++;
			}
			const kind = this.source[scriptPosition];
			if (kind !== "_" && kind !== "^") {
				break;
			}
			this.position = scriptPosition + 1;
			const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
			if (kind === "_") {
				if (lower !== undefined) {
					this.supported = false;
				}
				lower = value;
			} else {
				if (upper !== undefined) {
					this.supported = false;
				}
				upper = value;
			}
		}

		if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
			const index = this.layoutNodes.push({ type: "operator", operator, lower, upper }) - 1;
			return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
		}

		let rendered = operator;
		if (lower !== undefined) {
			rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
		}
		if (upper !== undefined) {
			rendered += formatScript(upper, "sup");
		}
		return spaced ? ` ${rendered} ` : rendered;
	}

	protected parseRequiredArgument(stackFractions = true): string {
		const previousStackFractions = this.stackFractions;
		this.stackFractions = previousStackFractions && stackFractions;
		const value = this.parseRequiredArgumentValue();
		this.stackFractions = previousStackFractions;
		return value;
	}

	protected parseRequiredArgumentValue(): string {
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.position >= this.source.length) {
			this.supported = false;
			return "";
		}
		if (this.source[this.position] === "{") {
			this.position++;
			return this.parseSequence("}");
		}
		if (this.source[this.position] === "\\") {
			return this.parseCommand();
		}
		const value = this.source[this.position] ?? "";
		this.position++;
		return value;
	}

	protected parseOptionalArgument(): string | undefined {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.source[this.position] !== "[") {
			return undefined;
		}
		const end = this.source.indexOf("]", this.position + 1);
		if (end < 0) {
			this.supported = false;
			return undefined;
		}
		const value = this.source.slice(this.position + 1, end);
		this.position = end + 1;
		return this.renderNested(value);
	}

	protected readRawGroup(): string | undefined {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.source[this.position] !== "{") {
			this.supported = false;
			return undefined;
		}

		const start = ++this.position;
		let depth = 1;
		while (this.position < this.source.length) {
			const character = this.source[this.position];
			if (character === "\\") {
				this.position += 2;
				continue;
			}
			if (character === "{") depth++;
			if (character === "}") depth--;
			if (depth === 0) {
				const value = this.source.slice(start, this.position);
				this.position++;
				return value;
			}
			this.position++;
		}
		this.supported = false;
		return undefined;
	}
}
