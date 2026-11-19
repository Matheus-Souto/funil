import { PDFDocument } from "pdf-lib";

/** PDF mínimo e válido (1 página), gerado pelo pdf-lib. */
export async function makePdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([10, 10]);
  return doc.save();
}

export const VALID_PDF: Uint8Array = await makePdf();

/** PDF com dicionário /Encrypt no trailer (pequeno, escrito à mão). */
export const ENCRYPTED_PDF: Uint8Array = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>
endobj
4 0 obj
<< /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>
endobj
trailer
<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>
%%EOF
`);

/** Começa com `%PDF-` mas o resto é lixo. */
export const CORRUPT_PDF: Uint8Array = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(16, 65)]);
