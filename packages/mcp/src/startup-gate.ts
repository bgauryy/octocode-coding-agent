/**
 * When a session's first connections whose launch carries the session's skill folders (the `researchRoots` template)
 * may launch, on a host that does not announce the folders its discovery adds (`McpPathsPort.announcedSkillRoots`).
 * The host adds the folders features contribute (`resources_discover`) only after every `session_start` handler ran.
 * A server launched before then would differ from the launch the first prompt computes, and be started a second time
 * there. So those connections wait for that discovery, or for whatever needs a server sooner: the first prompt, a
 * hook's call, a catalog command, or the session ending. Other launches do not wait (`events.ts`).
 */
export class StartupGate {
	private release: () => void = () => undefined;
	/** Settles once the startup connections may launch. */
	ready: Promise<void> = Promise.resolve();

	/** A new session started: its startup connections wait again. */
	close(): void {
		this.ready = new Promise<void>((resolve) => (this.release = resolve));
	}

	/** The host discovered the session's resources: they are applied right after the handlers return, so open a turn later. */
	discovered(): void {
		const release = this.release;
		setImmediate(release);
	}

	/** Something needs a server now: launch with what is known. */
	open(): void {
		this.release();
	}
}
