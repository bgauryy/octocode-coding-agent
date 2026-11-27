import { useEffect, useMemo, useState } from "react";
import type { ComponentProps } from "react";
import { App } from "../App.tsx";
import type { LiveExtension } from "../extension.ts";
import type { PageScope } from "../../scope.ts";
import { createDaemonApi } from "./api.ts";
import { daemonLive } from "./live.ts";

/**
 * The live app on one daemon scope. It asks the daemon whether its token may change the board and draws edit
 * controls only when the answer is yes: read-only until the answer arrives, and for a failed or refused request. The
 * daemon enforces the token on every write; this only decides what the page offers.
 */
export function DaemonScopedApp({
	live,
	scope,
	access,
	backlog,
}: {
	live: LiveExtension;
	scope: NonNullable<PageScope>;
	access: string;
} & Pick<ComponentProps<typeof App>, "backlog">) {
	const [rights, setRights] = useState({ writable: false, terminalCommands: false });
	useEffect(() => {
		const controller = new AbortController();
		createDaemonApi(access)
			.access(controller.signal)
			.then(
				(value) =>
					!controller.signal.aborted &&
					setRights({ writable: value.writable, terminalCommands: value.terminalCommands === true }),
				() => undefined,
			);
		return () => controller.abort();
	}, [access]);
	const scoped = useMemo(
		() => daemonLive(live, scope, rights.writable, rights.terminalCommands),
		[live, scope, rights],
	);
	return <App backlog={backlog} live={scoped} access={access} />;
}
