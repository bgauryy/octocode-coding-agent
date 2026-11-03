# Output

A short report in task terms.

- **Cause:** the file and line, the value or state observed there, what it should have been, and the command that showed it.
- **Fix:** what changed, and the reproduction and tests rerun after it with their result.
- **Profiling:** the command, the top rows before and after (self and total cost), and the measured change with the same command.
- **Not established:** what the runs could not show (for example a race that did not reproduce, or a build without debug information).

Save profiles, debugger logs and scratch programs to `<workspace>/.octocode/octocode-debugging/`, and remove temporary `debugger;` statements, `breakpoint()` calls and debug prints from the source.
