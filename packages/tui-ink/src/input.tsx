import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";

/** Handles one parsed terminal input sequence; `true` consumes it so nothing below sees it. */
export type InputHandler = (data: string) => boolean | undefined | void;

/** Where parsed input comes from: the terminal's stdin buffer, keyboard protocol and paste handling. */
export interface InputSource {
	subscribe(listener: (data: string) => boolean): () => void;
}

/** Handlers in mount order; the newest active one sees input first, like a dialog above the editor. */
export class FocusStack {
	private readonly entries: { readonly handler: InputHandler }[] = [];

	push(handler: InputHandler): () => void {
		const entry = { handler };
		this.entries.push(entry);
		return () => {
			const index = this.entries.indexOf(entry);
			if (index !== -1) this.entries.splice(index, 1);
		};
	}

	get size(): number {
		return this.entries.length;
	}

	dispatch(data: string): boolean {
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			if (this.entries[index]?.handler(data) === true) return true;
		}
		return false;
	}
}

const InputContext = createContext<FocusStack | undefined>(undefined);

export function InputProvider({ source, children }: { source?: InputSource; children: ReactNode }): ReactNode {
	const stack = useMemo(() => new FocusStack(), []);
	useEffect(() => source?.subscribe((data) => stack.dispatch(data)), [source, stack]);
	return <InputContext value={stack}>{children}</InputContext>;
}

export function useFocusStack(): FocusStack {
	const stack = useContext(InputContext);
	if (!stack) throw new Error("useInputHandler needs an InputProvider above it");
	return stack;
}

/** Receive input while `active`; the latest handler is read at each key, so it may close over fresh state. */
export function useInputHandler(handler: InputHandler, options: { active?: boolean } = {}): void {
	const stack = useFocusStack();
	const latest = useRef(handler);
	latest.current = handler;
	const active = options.active ?? true;
	useEffect(() => (active ? stack.push((data) => latest.current(data)) : undefined), [stack, active]);
}

/** A mouse wheel step from an SGR (1006) report: -1 up, 1 down; undefined for anything else. */
export function parseWheel(data: string): -1 | 1 | undefined {
	const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
	if (!match) return undefined;
	const button = Number.parseInt(match[1] ?? "", 10);
	if ((button & 64) === 0) return undefined;
	const direction = button & 3;
	return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
}
