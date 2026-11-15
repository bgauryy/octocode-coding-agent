/**
 * Who is working, as the terminal names it: the main agent (a session a person drives) as a squid, a subagent as an
 * octopus. The team panel, the footer, the tab title, `/processes` and the agent rows in the transcript all use these,
 * so one glance tells the session from the agents it started. Both are emoji with default emoji presentation: two
 * cells wide wherever they are drawn.
 */
export const ENTITY = { main: "🦑", subagent: "🐙" } as const;

/** Process roles that run a main session: the terminal app, an RPC host and an ACP host. Every other role is a subagent's. */
const MAIN_ROLES: ReadonlySet<string> = new Set(["main", "rpc", "acp"]);

/** The mark of a process role (`main`, `rpc`, `acp`, or a subagent's role such as `researcher`). */
export const entityOfRole = (role: string): string => (MAIN_ROLES.has(role) ? ENTITY.main : ENTITY.subagent);
