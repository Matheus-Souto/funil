// Uso: bun run store:create --name <n> --slug <s> --owner-email <e> [--domain <d>]  (MODE=multi)
import { parseArgs } from "node:util";
import { ActionError } from "@/lib/actions/core";
import { env } from "@/lib/env";
import { createStoreWithOwner } from "@/lib/stores";

const USAGE = "uso: bun run store:create --name <nome> --slug <slug> --owner-email <e-mail> [--domain <domínio>]";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      "owner-email": { type: "string" },
      domain: { type: "string" },
    },
    strict: true,
  });
  if (env.MODE !== "multi") {
    console.error("store:create só funciona com MODE=multi");
    return 1;
  }
  if (!values.name || !values.slug || !values["owner-email"]) {
    console.error(USAGE);
    return 1;
  }
  try {
    const r = await createStoreWithOwner({
      name: values.name,
      slug: values.slug,
      ownerEmail: values["owner-email"],
      domain: values.domain,
    });
    console.log(`Loja criada: ${values.slug} (${r.storeId})`);
    if (r.temporaryPassword) {
      console.log(`Senha temporária de ${values["owner-email"]} (aparece só agora): ${r.temporaryPassword}`);
    } else {
      console.log(`${values["owner-email"]} já existia e foi vinculado como dono (senha inalterada).`);
    }
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
