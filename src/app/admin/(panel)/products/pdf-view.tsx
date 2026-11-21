"use client";

// Nome do produto com o ícone 3D e o número de páginas, e o visualizador "Ver PDF" (páginas ao lado, página grande no
// meio, do tamanho da tela, e baixar). O arquivo vem da rota do painel /admin/api/products/<id>/file.
import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Download, Eye } from "lucide-react";
import { Dialog as ArcDialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { Art } from "../../blocks";
import { openPdf, pageAspect, productPdfUrl, startRender, type PdfDoc } from "../../pdf";
import s from "../../panel.module.css";

const plural = (n: number) => `${n} ${n === 1 ? "página" : "páginas"}`;

/** Um PDF aberto por produto, compartilhado entre a contagem antiga e o visualizador. */
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

/** Página `n` de um PDF desenhada num canvas de largura fixa (redesenha se a largura mudar). */
function PageCanvas({ doc, n, width, className }: { doc: PdfDoc; n: number; width: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || width <= 0) return;
    const job = startRender(doc, n, ref.current, width);
    job.promise.catch(() => undefined);
    return job.cancel;
  }, [doc, n, width]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

/**
 * Nome do produto com o ícone 3D de PDF e o número de páginas. O número vem do servidor (gravado no envio); só produtos
 * anteriores a isso (`pages` nulo) abrem o PDF no navegador para contar, quando a linha aparece na tela.
 */
export function ProductCell({ id, name, pages }: { id: string; name: string; pages: number | null }) {
  const box = useRef<HTMLSpanElement>(null);
  const [counted, setCounted] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (pages !== null || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        docFor(id).then(
          (d) => setCounted(d.numPages),
          () => undefined,
        );
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [id, pages]);
  const n = pages ?? counted;
  return (
    <span className={s.productCell}>
      <Art name="pdf" size={36} className={s.productArt} />
      <span ref={box} className={s.productCellText}>
        <b>{name}</b>
        <small>{n !== null ? plural(n) : " "}</small>
      </span>
    </span>
  );
}

/** Tamanho da área da página grande, acompanhando a janela. */
function useBoxSize(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setSize((old) => (Math.abs(old.w - r.width) < 2 && Math.abs(old.h - r.height) < 2 ? old : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return size;
}

/** Botão (ícone) "Ver PDF" e o visualizador (Esc ou fora fecha). */
export function PdfViewerButton({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [aspect, setAspect] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const box = useBoxSize(stage, open && doc !== null);
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
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    void pageAspect(doc, page).then((a) => alive && setAspect(a));
    return () => {
      alive = false;
    };
  }, [doc, page]);
  const pages = doc?.numPages ?? 0;
  // A página inteira cabe na área (sem rolar): limitada pela largura e pela altura.
  const width = aspect && box.w > 0 ? Math.floor(Math.min(box.w - 32, (box.h - 32) * aspect)) : 0;
  return (
    <>
      <Tooltip content="Ver PDF">
        <button type="button" className={s.iconBtn} onClick={() => setOpen(true)} aria-label={`Ver o PDF de ${name}`}>
          <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Tooltip>
      <ArcDialog open={open} onOpenChange={setOpen}>
        <DialogContent title={name} description={pages ? plural(pages) : undefined} className={`${s.themeVars} ${s.pdfDialog}`} aria-describedby={undefined}>
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
                      <PageCanvas doc={doc} n={n} width={72} />
                      <span>{n}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <div className={s.pdfMain}>
                <div ref={stage} className={s.pdfStage}>
                  {width > 0 ? <PageCanvas key={page} doc={doc} n={page} width={width} className={s.pdfPage} /> : null}
                </div>
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
