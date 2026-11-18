import { z } from "zod";
import type { Action } from "./core";
import type { Permission } from "./permissions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry = new Map<string, Action<any, any>>();

export interface ActionInfo {
  name: string;
  description: string;
  permission: Permission | "public" | "system";
  sensitive: boolean;
  inputSchema: z.core.JSONSchema.JSONSchema;
}

/** Catálogo de ações (usado pelo MCP na fase 2). */
export function listActions(): ActionInfo[] {
  return [...registry.values()].map((a) => ({
    name: a.name,
    description: a.description,
    permission: a.permission,
    sensitive: a.sensitive ?? false,
    inputSchema: z.toJSONSchema(a.input),
  }));
}
