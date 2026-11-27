/** Side-effect import: installs the MCP workspace's tool-row render port (see `render.ts`). Import it where MCP tools are built. */
import { installMcpRenderPort } from "./render.ts";

installMcpRenderPort();
