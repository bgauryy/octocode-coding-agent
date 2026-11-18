import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import {
	Box,
	type Component,
	Container,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
	renderChanged,
	trackRenderChanges,
} from "@octocodeai/octocode-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/features/types.ts";
import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { theme } from "../../../theme/theme.ts";
import { callFallback, rendererFailure, rendererFailureRow, resultFallback } from "./tool-execution/fallback.ts";
import { withGenericRenderers } from "./tool-execution/generic.ts";
import { purposeRows, reasonRow, toolArgsForDisplay } from "../../../octocode/ui/reason-row.ts";
import { argsKey, hasHiddenContent } from "./tool-execution/hidden.ts";
import { releaseToolRowState } from "./tool-execution/release.ts";
import type { ToolExecutionOptions, ToolExecutionResult } from "./tool-execution/types.ts";
import { displayRenderers, rowDisplay } from "./tool-execution/display.ts";
import { noImages, updateImageRows, type ImageRows } from "./tool-execution/images.ts";
import * as life from "./tool-execution/state.ts";
import { resultPurposeData, type ToolDisplay } from "@octocodeai/octocode-contracts";
export type { ToolExecutionOptions } from "./tool-execution/types.ts";

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private images: ImageRows = noImages();
	/** The host's display of this call, from the application stream; without it the row builds the same one itself. */
	private liveDisplay?: ToolDisplay;
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private argsKey: string | undefined;
	private expanded = false;
	/** The tool draws no rows of its own: expanded, the row lists every argument the header only summarizes. */
	private generic: boolean;
	/** Expanded or collapsed since the display was built: it is built again when the row next renders. */
	private displayStale = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	/** The call's lifecycle; every flag the renderers see is derived from it. */
	private lifecycle: life.ToolPhase = life.initialToolPhase;
	/** Cache of the last display build: true when it drew nothing. */
	private hideComponent = false;

	private get result(): ToolExecutionResult | undefined {
		return life.phaseResult(this.lifecycle);
	}

	private get isPartial(): boolean {
		return life.isPartialPhase(this.lifecycle);
	}

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions,
		toolDefinition: ToolRenderers | ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.argsKey = argsKey(args);
		this.generic = !(toolDefinition?.renderCall ?? toolDefinition?.renderResult) && !toolDefinition?.display;
		this.toolDefinition = withGenericRenderers(
			displayRenderers(toolDefinition, () =>
				rowDisplay({
					live: this.liveDisplay,
					definition: toolDefinition,
					toolName,
					args: this.args,
					result: this.result,
					isPartial: this.isPartial,
				}),
			),
			toolName,
		);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// The band starts at the header row and ends at the last body row: no vertical padding.
		this.contentBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);

		this.updateDisplay();
	}

	/** Releases the row's clock subscriptions (mark animation, elapsed-time tick) when it leaves the transcript. */
	dispose(): void {
		releaseToolRowState(this.rendererState);
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return Boolean(this.toolDefinition?.renderCall ?? this.toolDefinition?.renderResult);
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: life.phaseExecutionStarted(this.lifecycle),
			argsComplete: life.phaseArgsComplete(this.lifecycle),
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
		};
	}

	private createCallFallback(): Component {
		return callFallback(this.toolName, this.args, this.getRenderContext(undefined));
	}

	private createResultFallback(): Component | undefined {
		return resultFallback(this.getTextOutput(), this.getRenderContext(undefined));
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (
				event.type !== "click" ||
				event.button !== "left" ||
				!hasHiddenContent({
					hasResult: this.result !== undefined,
					generic: this.generic,
					toolName: this.toolName,
					args: this.args,
				})
			)
				return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	private transition(next: life.ToolPhase): void {
		if (life.samePhase(this.lifecycle, next)) return;
		this.lifecycle = next;
		this.updateDisplay();
		this.ui.requestRender();
	}

	/** A streamed reply repeats every call's arguments on each delta: only a call whose arguments changed is redrawn. */
	updateArgs(args: any): void {
		const key = argsKey(args);
		const same = key !== undefined && key === this.argsKey;
		this.args = args;
		this.argsKey = key;
		if (!same) this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.transition(life.executionStarted(this.lifecycle));
	}

	setArgsComplete(): void {
		this.transition(life.argsCompleted(this.lifecycle));
	}

	/** The host's display of the call; a row without one draws the display it builds from the same result. */
	setDisplay(display: ToolDisplay | undefined): void {
		this.liveDisplay = display;
	}

	updateResult(result: ToolExecutionResult, isPartial = false): void {
		this.lifecycle = life.resultReceived(this.lifecycle, result, isPartial);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		// A result that scrolled away leaves its rows in scrollback when it collapses; only the screen is repainted.
		if (this.expanded && !expanded) this.ui.keepScrollbackOnCollapse?.();
		this.expanded = expanded;
		// Expand-all reaches every row of a long transcript: only the rows that are drawn rebuild their display now.
		this.displayStale = true;
		renderChanged(this);
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.displayStale) this.updateDisplay();
		try {
			return this.renderContent(width);
		} catch (error) {
			const context = this.getRenderContext(undefined);
			return rendererFailureRow(error, this.toolName, context, this.getTextOutput(), this.outputPad).render(width);
		}
	}

	private renderContent(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
			if (contentLines.length === 0 && this.images.components.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (const [index, image] of this.images.components.entries()) {
				lines.push(...(this.images.spacers[index]?.render(width) ?? []), ...image.render(width));
			}
			return lines;
		}

		return super.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
		});
	}

	private updateDisplay(): void {
		this.displayStale = false;
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
				renderContainer.setPaddingX(this.outputPad);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch (error) {
					this.callRendererComponent = undefined;
					const fallback = callFallback(this.toolName, this.args, this.getRenderContext(undefined), error);
					renderContainer.addChild(this.createResultRegion(fallback));
					hasContent = true;
				}
			}
			const { toolName, args, expanded } = this;
			const reason = reasonRow(toolName, args, resultPurposeData(this.result), expanded);
			if (reason) renderContainer.addChild(this.createResultRegion(reason));
			if (this.generic && expanded && args !== undefined && args !== null) {
				const detail = formatToolCallWithArgs("", reason ? toolArgsForDisplay(toolName, args, true) : args, theme, true)
					.split("\n")
					.slice(1)
					// The 2-column gutter moves to the Text padding so a wrapped line keeps it too.
					.map((line) => (line.startsWith("  ") ? line.slice(2) : line))
					.join("\n");
				if (detail) renderContainer.addChild(new Text(detail, 2, 0));
			}
			if (this.result) {
				const purpose = purposeRows(toolName, args, resultPurposeData(this.result), expanded);
				if (purpose) renderContainer.addChild(this.createResultRegion(purpose));
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{
								...this.result,
								content: this.result.content as AgentToolResult["content"],
								details: this.result.details,
							},
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch (error) {
						this.resultRendererComponent = undefined;
						const fallback = rendererFailure("Result", error, this.getTextOutput(), this.getRenderContext(undefined));
						renderContainer.addChild(this.createResultRegion(fallback));
						hasContent = true;
					}
				}
			}
		}

		this.images = updateImageRows(this, this.images, this.result?.content, {
			show: this.showImages,
			widthCells: this.imageWidthCells,
			redraw: () => {
				this.invalidate();
				this.ui.requestRender();
			},
		});

		if (this.hasRendererDefinition() && !hasContent && this.images.components.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}
}

// Every state its rows read changes in `updateDisplay`, which rebuilds its children. A frame drawn without its children
// (hidden, or a renderer's own shell) does not settle, so parents draw the row again every frame.
trackRenderChanges(ToolExecutionComponent.prototype);
