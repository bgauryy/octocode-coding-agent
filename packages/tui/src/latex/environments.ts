import { visibleWidth } from "../utils/width.ts";
import { LAYOUT_MARKER_END, LAYOUT_MARKER_START, PROTECTED_SPACE } from "./layout.ts";
import { LatexParserBase } from "./parser-base.ts";

/** LaTeX environments: aligned rows, cases and matrices. */
export abstract class LatexEnvironmentParser extends LatexParserBase {
	protected splitEnvironmentRows(body: string): string[] {
		return body.split(/\\\\(?:\[[^\]\n]*\])?/);
	}

	protected parseEnvironment(): string {
		const environment = this.readRawGroup();
		if (!environment) {
			return "";
		}
		const endMarker = `\\end{${environment}}`;
		const end = this.source.indexOf(endMarker, this.position);
		if (end < 0) {
			this.supported = false;
			return "";
		}
		const body = this.source.slice(this.position, end);
		this.position = end + endMarker.length;

		if (environment === "equation" || environment === "equation*" || environment === "displaymath") {
			return this.renderNested(body).trim();
		}

		if (
			environment === "aligned" ||
			environment === "align" ||
			environment === "align*" ||
			environment === "alignedat" ||
			environment === "alignat" ||
			environment === "alignat*" ||
			environment === "gather" ||
			environment === "gathered" ||
			environment === "multline" ||
			environment === "multline*" ||
			environment === "split"
		) {
			const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
			const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return this.splitEnvironmentRows(alignedBody)
				.map((row) => {
					const cells = row.split("&");
					const source = alignedAt
						? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
								cells.slice(index * 2, index * 2 + 2).join(""),
							).join(" ")
						: cells.join("");
					return this.renderNested(source).trim();
				})
				.filter(Boolean)
				.join("\n");
		}

		if (environment === "cases" || environment === "cases*") {
			return this.renderCases(body);
		}

		if (
			["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(environment)
		) {
			const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return this.renderMatrix(environment, matrixBody);
		}

		this.supported = false;
		return body;
	}

	protected renderCases(body: string): string {
		const rows = this.splitEnvironmentRows(body)
			.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
			.filter((row) => row.some(Boolean));
		const valueWidth = Math.max(0, ...rows.map((row) => visibleWidth((row[0] ?? "").replace(/,\s*$/, ""))));
		const contents = rows.map((row) => {
			const value = (row[0] ?? "").replace(/,\s*$/, "");
			const condition = row[1] ?? "";
			if (!condition) {
				return value;
			}
			const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
			return `${value}${PROTECTED_SPACE.repeat(valueWidth - visibleWidth(value))}${conditionPrefix}${condition}`;
		});
		if (contents.length <= 1) {
			return contents.length === 0 ? "" : `⎧ ${contents[0]}`;
		}

		const middle = Math.floor(contents.length / 2);
		const visualRows: Array<string | undefined> = [...contents];
		if (contents.length % 2 === 0) {
			visualRows.splice(middle, 0, undefined);
		}
		const lines = visualRows.map((content, index) => {
			const delimiter = index === 0 ? "⎧" : index === visualRows.length - 1 ? "⎩" : "⎨";
			return content === undefined ? delimiter : `${delimiter} ${content}`;
		});
		const index = this.layoutNodes.push({ type: "matrix", lines, baseline: middle }) - 1;
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	protected renderMatrix(environment: string, body: string): string {
		const matrix = this.splitEnvironmentRows(body)
			.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
			.filter((row) => row.some(Boolean));
		const columnCount = Math.max(0, ...matrix.map((row) => row.length));
		const columnWidths = Array.from({ length: columnCount }, (_, column) =>
			Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? ""))),
		);
		const rows = matrix.map((row) =>
			Array.from({ length: columnCount }, (_, column) => {
				const cell = row[column] ?? "";
				return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
			}).join(" │ "),
		);

		let lines: string[];
		if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
			lines = rows;
		} else {
			const delimiters: Readonly<Record<string, readonly [string, string, string, string, string, string]>> = {
				pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
				bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
				Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
				vmatrix: ["│", "│", "│", "│", "│", "│"],
				Vmatrix: ["║", "║", "║", "║", "║", "║"],
			};
			const delimiter = delimiters[environment];
			if (!delimiter) {
				this.supported = false;
				return rows.join("\n");
			}
			lines = rows.map((row, index) => {
				const left = index === 0 ? delimiter[0] : index === rows.length - 1 ? delimiter[4] : delimiter[2];
				const right = index === 0 ? delimiter[1] : index === rows.length - 1 ? delimiter[5] : delimiter[3];
				return `${left} ${row} ${right}`;
			});
		}

		if (lines.length <= 1) {
			return lines[0] ?? "";
		}
		const index = this.layoutNodes.push({ type: "matrix", lines, baseline: 0 }) - 1;
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}
}
