/** Side-effect import: lets the HTML export draw each tool call's reason and purpose rows as the terminal does. */
import { installExportToolRows } from "../../core/export-html/tool-rows.ts";

installExportToolRows(() => import("./reason-row.ts"));
