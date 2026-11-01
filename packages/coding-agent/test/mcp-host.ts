// Installs the MCP host ports the way the CLI's composition roots do (main.ts, resource-loader/builtins.ts,
// interactive-mode.ts). Import it first in a test that drives MCP modules directly; tests that go through a session or
// resource loader get the ports from builtins.ts. The coding-agent suites do not use it as a setup file: a setup file
// loads this module graph before the test's `vi.mock` calls register, so those mocks would not reach the modules it
// loaded. The mcp and acp suites, whose every test drives MCP, list it in their setupFiles.
import "../src/octocode/mcp-host/core-install.ts";
import "../src/octocode/mcp-host/render-install.ts";
import "../src/modes/interactive/mcp-ui-install.ts";
