import type { FileGuard } from "./guard.ts";

/** What the team layer gives one guard about sessions editing the same files; neither call refuses a change. */
export interface ConcurrentEdits {
	/** One line naming another live session that declared `file`, or undefined: asked before the change. */
	notice(file: string, display: string): string | undefined;
	/** Records that this session changed `file` (only after the change landed); a line when it could not. */
	declare(file: string): string | undefined;
}

export const concurrentEdits = new WeakMap<FileGuard, ConcurrentEdits>();

/** The lines a change's result carries about other sessions editing the same file: asked before it, recorded after it landed. */
export class EditingNote {
	private readonly hooks: ConcurrentEdits | undefined;
	private readonly file: string;
	private extra: string;
	constructor(guard: FileGuard, file: string, display: string) {
		this.hooks = concurrentEdits.get(guard);
		this.file = file;
		const notice = this.hooks?.notice(file, display);
		this.extra = notice ? `\n${notice}` : "";
	}

	declare(): void {
		const failed = this.hooks?.declare(this.file);
		if (failed) this.extra += `\n${failed}`;
	}

	/** Empty, or newline-led lines for the result message. */
	get text(): string {
		return this.extra;
	}
}
