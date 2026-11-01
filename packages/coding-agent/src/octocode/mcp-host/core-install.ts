/** Side-effect import: installs the MCP workspace's core host ports (see `core.ts`). Import it where MCP code first runs. */
import { installMcpCorePorts } from "./core.ts";

installMcpCorePorts();
