import {
	ACCENTS,
	BLACKBOARD,
	DISPLAY_LIMIT_SYMBOLS,
	FONT_SWITCH_COMMANDS,
	IGNORED_COMMANDS,
	LIMIT_OPERATORS,
	NAMED_OPERATORS,
	NEGATED_SYMBOLS,
	NEGATIVE_SPACE,
	NEGATIVE_SPACING_COMMANDS,
	PLAIN_WRAPPERS,
	RELATION_COMMANDS,
	SIZE_COMMANDS,
	SPACING_COMMANDS,
} from "./latex/commands.ts";
import { LatexEnvironmentParser } from "./latex/environments.ts";
import {
	formatFraction,
	formatRoot,
	formatScript,
	NAMED_OPERATOR_END,
	NAMED_OPERATOR_START,
	normalizeOutput,
} from "./latex/format.ts";
import {
	LAYOUT_MARKER_END,
	LAYOUT_MARKER_START,
	type LayoutNode,
	PROTECTED_SPACE,
	renderLayout,
	TRAILING_LAYOUT_MARKER_PATTERN,
} from "./latex/layout.ts";
import { SYMBOLS } from "./latex/symbols.ts";

class LatexParser extends LatexEnvironmentParser {
	render(): string | undefined {
		const rendered = this.parseSequence();
		if (!this.supported || this.position !== this.source.length) {
			return undefined;
		}
		return normalizeOutput(rendered);
	}

	protected parseSequence(endCharacter?: string): string {
		let result = "";
		while (this.position < this.source.length) {
			const character = this.source[this.position];
			if (endCharacter && character === endCharacter) {
				this.position++;
				return result;
			}

			if (character === "}") {
				this.supported = false;
				return result;
			}

			if (character === "{") {
				this.position++;
				result += this.parseSequence("}");
				continue;
			}

			if (character === "\\") {
				const command = this.parseCommand();
				if (command === NEGATIVE_SPACE) {
					result = result.trimEnd();
					if (result.endsWith(NAMED_OPERATOR_END)) {
						result = result.slice(0, -NAMED_OPERATOR_END.length);
					}
				} else {
					result += command;
				}
				continue;
			}

			if (character === "^" || character === "_") {
				this.position++;
				result = result.trimEnd();
				const script = this.parseScripts(character);
				if (result.endsWith(NAMED_OPERATOR_END)) {
					result = `${result.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
				} else {
					result += script;
				}
				continue;
			}

			if (/\s/.test(character)) {
				result += this.parseWhitespace();
				continue;
			}

			if (character === "=" || character === "<" || character === ">") {
				result = `${result.trimEnd()} ${character} `;
				this.position++;
				continue;
			}

			if (character === "&") {
				this.position++;
				continue;
			}

			if (character === "~") {
				this.position++;
				result += " ";
				continue;
			}

			if (character === ".") {
				const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
				const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
				if (node?.type === "matrix") {
					const lastLine = node.lines.length - 1;
					node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
					this.position++;
					continue;
				}
			}

			result += character;
			this.position++;
		}

		if (endCharacter) {
			this.supported = false;
		}
		return result;
	}

	protected parseCommand(): string {
		this.position++;
		if (this.position >= this.source.length) {
			this.supported = false;
			return "";
		}

		let command = "";
		const first = this.source[this.position] ?? "";
		if (first === "\n" || first === "\r") {
			this.position++;
			if (first === "\r" && this.source[this.position] === "\n") {
				this.position++;
			}
			return " ";
		}
		if (/[A-Za-z]/.test(first)) {
			const start = this.position;
			while (this.position < this.source.length && /[A-Za-z]/.test(this.source[this.position] ?? "")) {
				this.position++;
			}
			command = this.source.slice(start, this.position);
		} else {
			command = first;
			this.position++;
		}

		if (command === "\\") {
			return "\n";
		}
		if (SPACING_COMMANDS.has(command)) {
			return " ";
		}
		if (NEGATIVE_SPACING_COMMANDS.has(command)) {
			return NEGATIVE_SPACE;
		}
		if (FONT_SWITCH_COMMANDS.has(command)) {
			while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
				this.position++;
			}
			return "";
		}
		if (IGNORED_COMMANDS.has(command)) {
			return "";
		}
		if (
			command === "{" ||
			command === "}" ||
			command === "$" ||
			command === "%" ||
			command === "#" ||
			command === "_" ||
			command === "&"
		) {
			return command;
		}
		if (command === "|") {
			return "‖";
		}
		if (command === "not") {
			const value = this.parseRequiredArgument(false).trim();
			const negated = NEGATED_SYMBOLS[value];
			if (negated !== undefined) {
				return ` ${negated} `;
			}
			const characters = Array.from(value);
			if (characters.length === 0) {
				this.supported = false;
				return "";
			}
			return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
		}
		if (LIMIT_OPERATORS.has(command)) {
			return this.parseOperator(command, "bracket", true, true);
		}

		const symbol = SYMBOLS[command];
		if (symbol !== undefined) {
			if (DISPLAY_LIMIT_SYMBOLS.has(command)) {
				return this.parseOperator(symbol, "script", true);
			}
			return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command) ? ` ${symbol} ` : symbol;
		}
		if (NAMED_OPERATORS.has(command)) {
			return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
		}
		if (SIZE_COMMANDS.has(command)) {
			return "";
		}
		if (command === "left" || command === "middle" || command === "right") {
			if (this.source[this.position] === ".") {
				this.position++;
			}
			return "";
		}
		if (command === "frac" || command === "dfrac" || command === "tfrac") {
			const shouldStack = this.display && this.stackFractions && command !== "tfrac";
			const numerator = this.parseRequiredArgument(!shouldStack);
			const denominator = this.parseRequiredArgument(!shouldStack);
			if (shouldStack) {
				const index =
					this.layoutNodes.push({
						type: "fraction",
						numerator: normalizeOutput(numerator),
						denominator: normalizeOutput(denominator),
					}) - 1;
				return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
			}
			return formatFraction(numerator, denominator);
		}
		if (command === "sqrt") {
			const degree = this.parseOptionalArgument()?.trim();
			const value = this.parseRequiredArgument();
			if (degree === undefined || degree === "2") {
				return formatRoot(value);
			}
			if (degree === "3") {
				return formatRoot(value, "∛");
			}
			if (degree === "4") {
				return formatRoot(value, "∜");
			}
			return `${formatScript(degree, "sup")}${formatRoot(value)}`;
		}
		if (command === "boxed" || command === "fbox") {
			return `[${this.parseRequiredArgument().trim()}]`;
		}
		if (command === "binom" || command === "dbinom" || command === "tbinom") {
			return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
		}
		const accent = ACCENTS[command];
		if (accent !== undefined) {
			const value = this.parseRequiredArgument();
			return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
		}
		if (command === "mathbb") {
			const value = this.parseRequiredArgument();
			return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
		}
		if (command === "operatorname") {
			const starred = this.source[this.position] === "*";
			if (starred) {
				this.position++;
			}
			const operator = normalizeOutput(this.parseRequiredArgument()).trim();
			return this.parseOperator(operator, "bracket", starred, true);
		}
		if (command === "mod" || command === "bmod") {
			return " mod ";
		}
		if (command === "pmod" || command === "pod") {
			const value = this.parseRequiredArgument().trim();
			return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
		}
		if (command === "overset" || command === "stackrel") {
			const upper = this.parseRequiredArgument();
			const value = this.parseRequiredArgument().trim();
			return `${value}${formatScript(upper, "sup")}`;
		}
		if (command === "underset") {
			const lower = this.parseRequiredArgument();
			const value = this.parseRequiredArgument().trim();
			return `${value}${formatScript(lower, "sub")}`;
		}
		if (PLAIN_WRAPPERS.has(command)) {
			const value = this.parseRequiredArgument();
			return command.startsWith("text") || command === "mbox" ? value : value.trim();
		}
		if (command === "begin") {
			return this.parseEnvironment();
		}
		if (command === "end") {
			this.supported = false;
			return "";
		}

		this.supported = false;
		return `\\${command}`;
	}

	protected renderNested(source: string, stackFractions = true): string {
		const rendered = new LatexParser(source, this.layoutNodes, this.display && stackFractions).render();
		if (rendered === undefined) {
			this.supported = false;
			return source;
		}
		return rendered;
	}
}

export interface RenderLatexOptions {
	/** Stack fractions and operator limits vertically for display math (default: false). */
	display?: boolean;
}

/**
 * Render a basic LaTeX math expression as terminal-friendly Unicode text.
 * Returns undefined when the expression contains unsupported or malformed syntax.
 */
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
	const layoutNodes: LayoutNode[] = [];
	const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
	if (rendered === undefined) {
		return undefined;
	}
	if (layoutNodes.length === 0) {
		return rendered.replaceAll(PROTECTED_SPACE, " ");
	}
	const lines = renderLayout(rendered, layoutNodes).lines;
	const indentation = Math.min(
		...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
	);
	return lines
		.map((line) => line.slice(indentation).trimEnd())
		.join("\n")
		.trimEnd()
		.replaceAll(PROTECTED_SPACE, " ");
}
