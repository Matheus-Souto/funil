// Uso: bun run store:domain --slug <s> (--domain <d> | --clear)  (MODE=multi)
import { parseArgs } from "node:util";
import { ActionError } from "@/lib/actions/core";
import { env } from "@/lib/env";
import { setStoreDomain } from "@/lib/stores";

const USAGE = "uso: bun run store:domain --slug <slug> (--domain <domínio> | --clear)";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      domain: { type: "string" },
      clear: { type: "boolean" },
    },
    strict: true,
  });
  if (env.MODE !== "multi") {
    console.error("store:domain só funciona com MODE=multi");
    return 1;
  }
  if (!values.slug || (values.clear ? values.domain !== undefined : !values.domain)) {
    console.error(USAGE);
    return 1;
  }
  try {
    const r = await setStoreDomain({ slug: values.slug, domain: values.clear ? null : values.domain! });
    const after = values.clear ? null : values.domain!.trim().toLowerCase();
    console.log(`Domínio da loja ${values.slug}: ${r.previous ?? "(nenhum)"} -> ${after ?? "(nenhum)"}`);
    return 0;
  } catch (e) {
    if (e instanceof ActionError) {
      console.error(`Erro: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

process.exit(await main());
