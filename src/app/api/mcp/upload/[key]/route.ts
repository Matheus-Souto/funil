import { handleUploadRequest } from "@/lib/mcp/uploads";

export const dynamic = "force-dynamic";

/** Upload de PDF por link de uso único (PUT; os outros métodos respondem 405). Ver src/lib/mcp/uploads.ts. */
const upload = async (req: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> =>
  handleUploadRequest(req, (await params).key);

export const PUT = upload;
export const GET = upload;
export const POST = upload;
export const PATCH = upload;
export const DELETE = upload;
