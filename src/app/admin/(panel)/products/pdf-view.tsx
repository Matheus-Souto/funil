"use client";

// Nome do produto com o ícone 3D e o número de páginas (o PDF é lido quando a linha aparece na tela) e o visualizador
// "Ver PDF" (páginas ao lado, página grande no meio, baixar). O arquivo vem da rota do painel /admin/api/products/<id>/file.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Eye } from "lucide-react";
import { Dialog as ArcDialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { Art } from "../../blocks";
import { openPdf, productPdfUrl, renderPage, type PdfDoc } from "../../pdf";
import s from "../../panel.module.css";

/** Um PDF aberto por produto, compartilhado entre a miniatura e o visualizador. */
const docs = new Map<string, Promise<PdfDoc>>();
function docFor(id: string): Promise<PdfDoc> {
  let p = docs.get(id);
  if (!p) {
    p = openPdf(productPdfUrl(id));
    p.catch(() => docs.delete(id));
    docs.set(id, p);
  }
  return p;
}

/** Página `n` de um PDF desenhada num canvas de largura fixa. */
function PageCanvas({ doc, n, width, className }: { doc: PdfDoc; n: number; width: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    if (ref.current)
      void renderPage(doc, n, ref.current, width).then(
        () => alive && setReady(true),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [doc, n, width]);
  return <canvas ref={ref} className={className} data-ready={ready ? "true" : undefined} aria-hidden="true" />;
}

/** Nome do produto com o ícone 3D de PDF e o número de páginas. */
export function ProductCell({ id, name }: { id: string; name: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        docFor(id).then(setDoc, () => setFailed(true));
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [id]);
  return (
    <span className={s.productCell}>
      <Art name="pdf" size={36} className={s.productArt} />
      <span ref={box} className={s.productCellText}>
        <b>{name}</b>
        <small>{doc ? `${doc.numPages} ${doc.numPages === 1 ? "página" : "páginas"}` : failed ? "Sem prévia" : " "}</small>
      </span>
    </span>
  );
}

/** Botão "Ver PDF" e o visualizador (Esc ou fora fecha). */
export function PdfViewerButton({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (!open || doc) return;
    let alive = true;
    docFor(id).then(
      (d) => alive && setDoc(d),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [open, doc, id]);
  const pages = doc?.numPages ?? 0;
  return (
    <>
      <Tooltip content="Ver PDF">
        <button type="button" className={s.iconBtn} onClick={() => setOpen(true)} aria-label={`Ver o PDF de ${name}`}>
          <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Tooltip>
      <ArcDialog open={open} onOpenChange={setOpen}>
        <DialogContent title={pages ? `${name} · ${pages} ${pages === 1 ? "página" : "páginas"}` : name} className={`${s.themeVars} ${s.pdfDialog}`} aria-describedby={undefined}>
          {failed ? (
            <p className={s.muted}>Não foi possível abrir este PDF.</p>
          ) : !doc ? (
            <div className={s.pdfLoading} aria-label="Carregando o PDF" />
          ) : (
            <div className={s.pdfViewer}>
              <ol className={s.pdfPages} aria-label="Páginas">
                {Array.from({ length: Math.min(pages, 60) }, (_, i) => i + 1).map((n) => (
                  <li key={n}>
                    <button type="button" onClick={() => setPage(n)} aria-current={n === page ? "true" : undefined} aria-label={`Página ${n}`}>
                      <PageCanvas doc={doc} n={n} width={64} />
                      <span>{n}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <div className={s.pdfMain}>
                <PageCanvas key={page} doc={doc} n={page} width={420} className={s.pdfPage} />
                <div className={s.pdfNav}>
                  <button type="button" className={s.iconBtn} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Página anterior">
                    <ChevronLeft size={16} />
                  </button>
                  <span>
                    {page} de {pages}
                  </span>
                  <button type="button" className={s.iconBtn} onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label="Próxima página">
                    <ChevronRight size={16} />
                  </button>
                  <a className={`${s.btn} ${s.btnSm}`} href={productPdfUrl(id)} download>
                    <Download size={14} strokeWidth={2} aria-hidden="true" />
                    Baixar
                  </a>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </ArcDialog>
    </>
  );
}
