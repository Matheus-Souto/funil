import { handleMcpRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/** Endpoint MCP da loja (token por loja). Ver src/lib/mcp/server.ts. */
const mcp = (req: Request): Promise<Response> => handleMcpRequest(req);

export const POST = mcp;
export const GET = mcp;
export const DELETE = mcp;
