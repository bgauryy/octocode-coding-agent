# Octocode Debugging

Bundled with Octocode. It teaches agents to debug and profile running programs through `bash`: breakpoints and locals with lldb, gdb, pdb and a Node inspector script, crashes, hangs, and CPU or memory hotspots. Every run is a batch command that finishes on its own, so it passes the shell permission gate like any other command.

- Start at [SKILL.md](SKILL.md).
- Output: the cause with the evidence that proves it ([output.md](output.md)); profiles and logs go under `<workspace>/.octocode/octocode-debugging/`.
- Setup: the system debugger for the language (`lldb` with Xcode command line tools on macOS, `gdb` on Linux, Python's `pdb`). The scripts need Node 22 or later and nothing else.
