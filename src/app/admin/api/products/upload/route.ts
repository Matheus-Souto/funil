import { handleProductUpload } from "@/lib/catalog/upload-http";

export const dynamic = "force-dynamic";

/** Upload do PDF de um produto (painel). Ver src/lib/catalog/upload-http.ts. */
export async function POST(req: Request): Promise<Response> {
  return handleProductUpload(req);
}
