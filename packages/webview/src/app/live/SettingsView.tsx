import { useMemo } from "react";
import { takeAccess } from "../../access.ts";
import { ConfigView } from "../config/ConfigView.tsx";
import { createDaemonApi } from "../daemon/api.ts";
import type { ViewProps } from "../extension.ts";

/** The id the host resolves to this session's repository; it is the only workspace the page offers. */
const SESSION_REPO_ID = "session";

/** Provider sources, credentials with sign-in, provider switches, default model and Harness switches for this session. */
export function SettingsPanel({ access, repo }: { access: string; repo: string }) {
	const api = useMemo(() => createDaemonApi(access), [access]);
	const harness = useMemo(() => ({ list: api.harness, set: api.setHarness }), [api]);
	const repos = useMemo(() => [{ id: SESSION_REPO_ID, name: repo }], [repo]);
	return (
		<ConfigView
			load={api.config}
			save={api.saveSetting}
			saveCredential={api.saveCredential}
			saveProvider={api.saveProvider}
			signIn={api.signIn}
			harness={harness}
			repos={repos}
		/>
	);
}

export function SettingsView({ index }: ViewProps) {
	return <SettingsPanel access={takeAccess()} repo={index.repo} />;
}
