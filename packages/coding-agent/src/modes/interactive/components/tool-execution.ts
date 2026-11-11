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
} from "@octocodeai/octocode-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/features/types.ts";
import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { rowMark, uiStateOf } from "../../../octocode/render/motion.ts";
import { phaseOf } from "../../../octocode/render/rows.ts";
import { theme } from "../../../theme/theme.ts";
import { createResultFallback, rendererFailure, rendererFailureText } from "./tool-execution/fallback.ts";
import { GenericToolContent } from "./tool-execution/content.ts";
import { purposeRows, reasonRow } from "../../../octocode/ui/reason-row.ts";
import { releaseToolRowState } from "./tool-execution/release.ts";
import type { ToolExecutionOptions, ToolExecutionResult } from "./tool-execution/types.ts";
import { displayRenderers, rowDisplay } from "./tool-execution/display.ts";
import { noImages, updateImageRows, type ImageRows } from "./tool-execution/images.ts";
import type { ToolDisplay } from "@octocodeai/octocode-contracts";
export type { ToolExecutionOptions } from "./tool-execution/types.ts";

/** Arguments as comparable text; undefined when they cannot be serialized, which always redraws. */
function argsKey(args: unknown): string | undefined {
	try {
		return JSON.stringify(args);
	} catch {
		return undefined;
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: GenericToolContent;
	private contentTextRegion: MouseRegion;
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
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: ToolExecutionResult;
	private hideComponent = false;

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
		this.toolDefinition = displayRenderers(toolDefinition, () =>
			rowDisplay({
				live: this.liveDisplay,
				definition: toolDefinition,
				toolName,
				args: this.args,
				result: this.result,
				isPartial: this.isPartial,
			}),
		);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new GenericToolContent(() => this.ui.requestRender());
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

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
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
		};
	}

	private createCallFallback(): Component {
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		return createResultFallback(this.getTextOutput(), this.expanded);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
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
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	/** The host's display of the call; a row without one draws the display it builds from the same result. */
	setDisplay(display: ToolDisplay | undefined): void {
		this.liveDisplay = display;
	}

	updateResult(result: ToolExecutionResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
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
		try {
			return this.renderContent(width);
		} catch (error) {
			const text = rendererFailureText(error, this.toolName, this.args, this.getTextOutput(), this.expanded);
			return new Text(text, this.outputPad, 0).render(width);
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
				// Vertical padding frames a background band; a theme without tool backgrounds would only get blank rows.
				renderContainer.setPaddingY(theme.paintsBackground("toolPendingBg") ? 1 : 0);
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
					const fallback = rendererFailure("renderCall", error, this.createCallFallback());
					renderContainer.addChild(this.createResultRegion(fallback));
					hasContent = true;
				}
			}
			const reason = reasonRow(this.toolName, this.args, this.result?.structuredContent);
			if (reason) renderContainer.addChild(this.createResultRegion(reason));
			if (this.result) {
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
						const fallback = rendererFailure("renderResult", error, this.createResultFallback());
						renderContainer.addChild(this.createResultRegion(fallback));
						hasContent = true;
					}
				}
				const purpose = purposeRows(this.toolName, this.args, this.result.structuredContent);
				if (purpose) renderContainer.addChild(this.createResultRegion(purpose));
			}
		} else {
			// A tool without a renderer wears the same mark as every other row.
			const context = this.getRenderContext(undefined);
			const mark = rowMark(theme, context, this.rendererState, uiStateOf(phaseOf(context)));
			this.contentText.update({
				mark,
				toolName: this.toolName,
				toolCallId: this.toolCallId,
				args: this.args,
				result: this.result,
				expanded: this.expanded,
				showImages: this.showImages,
				imageWidthCells: this.imageWidthCells,
				outputPad: this.outputPad,
				background: bgFn,
				...(this.result && !this.isPartial ? { isError: this.result.isError, durationMs: this.result.durationMs } : {}),
			});
			return;
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
