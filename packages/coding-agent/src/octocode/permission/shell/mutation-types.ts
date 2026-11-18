/**
 * What a shell command changes, as far as its parse shows: a policy for read-only roles and team reservations, not a
 * sandbox. It sees redirections, `tee`, in-place editors, file-moving programs, git and package-manager commands that
 * change the tree, destinations named by options (`dd of=`, `curl -o`, `tar -C`, `git -C`, `git config`), commands
 * `find -exec` runs, and scripts passed to `sh -c` or `eval`. It does not see what an interpreter (`node script.js`,
 * `make`) does. A program name that is computed (`$X a b`, `$(…) a b`) is `uncertain`. `~` and `$HOME` spellings are
 * kept as `~` paths.
 */
export interface ShellMutation {
	/** Paths the command writes, moves or removes, as written (relative to the command's cwd). */
	writes: string[];
	/** The `writes` that only create a directory (`mkdir`'s operands), for a policy that allows a folder it may fill. */
	directories: string[];
	/** Directories a change in `opaque` happens in (`.` for where the command runs, `git -C dir`'s repository): what the permission check classifies when no path is named. */
	areas: string[];
	/** Changes with no path to name (`git commit`, `sed -i`, `npm install`), one short description each. */
	opaque: string[];
	/** Git calls that are not a read a read-only role may run (`gitUnread`, `gitRoleGlobal`): the closed list only that role answers to, since most of them only read too (`git merge-base`) or stay in the repository (`git fetch`). */
	unread: string[];
	/** Where those calls run, for a guard about one directory. */
	unreadAreas: string[];
	/** Git commands that move a ref every worktree of the repository shares (`git branch -f`, `git update-ref`): `gitRefMove`. */
	refMoves: string[];
	/** Databases `sqlite3` opens for writing, as written; a command changes one with no other sign, so a caller decides which matter. */
	databases: string[];
	/** The command writes somewhere the parse could not resolve (`> $FILE`), or did not parse. */
	uncertain: boolean;
	/** The first reason for `uncertain` other than a `cd`: what the caller must change (`> $FILE`, a `$VAR` operand, a script the parse cannot read). */
	uncertainBecause?: string;
	/** `uncertain` because a relative path follows a `cd` the parse could not follow (a variable, `-`, `||`, a loop): the command can be written with absolute paths or without the `cd`. */
	afterDirectoryChange?: true;
	/** A relative write was also kept at the starting directory, because the `cd` before it is joined by `;` (or a newline) and may have failed; `&&` would settle it. */
	afterUnjoinedCd?: true;
	/** Why an awk call is outside its fail-safe allowlist (`awk-program.ts`): only the read-only role and the isolated-tree guard act on it, so other modes read awk as they did before it (its in-place edit, not its program). */
	awkUnread?: string;
	/** Why a variable the line sets (`PATH=/tmp/x cat f`, `export X=1`) or a `-v` subscript test (`programSwap`) may run a program or code no command names: only the read-only role, the isolated-tree guard and bash ordering act on it, since in other modes the command it reaches is judged as written. */
	programSwap?: string;
	/** The parse gave up on (part of) the command: no parser, too large, timed out, or syntax it does not know. Its `writes` may be missing some. */
	unparsed: boolean;
}
