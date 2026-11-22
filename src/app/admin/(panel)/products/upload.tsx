"use client";

// Novo produto: botão no topo da página que abre um modal com nome + PDF. Ao escolher o arquivo, o navegador já
// desenha a 1ª página e conta as páginas (pdf.js); o envio segue em streaming para a rota autenticada
// /admin/api/products/upload, com barra de progresso, etapas e cancelar. A validação que vale é a do servidor
// (PDF inválido, criptografado, > 50 MB...): a prévia só adianta o aviso.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus, X } from "lucide-react";
import { Art } from "../../blocks";
import { isPasswordError, openPdf, renderPage } from "../../pdf";
import s from "../../panel.module.css";
import { Dialog, Live } from "../../ui";

const MAX = 52_428_800;
// Mesmos tetos de MAX_PDF_BYTES e MAX_PDF_PAGES (src/lib/catalog/products.ts, que usa o banco e não vai ao navegador).
const MAX_PAGES = 1000;
const mb = (n: number) => `${(n / 1_048_576).toFixed(1).replace(".", ",")} MB`;

type Preview = { status: "reading" } | { status: "ok"; pages: number } | { status: "none"; reason: string };

export function NewProductButton() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  return (
    <>
      <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setOpen(true)}>
        <Plus size={16} strokeWidth={2} aria-hidden="true" />
        Novo produto
      </button>
      <NewProductDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(name) => {
          setOpen(false);
          setDone({ tone: "ok", text: `Produto “${name}” criado.` });
        }}
      />
      <Live msg={done} />
    </>
  );
}

function NewProductDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const router = useRouter();
  const busy = progress !== null;

  function reset() {
    setName("");
    setFile(null);
    setPreview(null);
    setProgress(null);
    setMsg(null);
    if (input.current) input.current.value = "";
  }

  // Prévia: abre o PDF escolhido no navegador e desenha a 1ª página.
  useEffect(() => {
    if (!file) return;
    let alive = true;
    let pdf: ReturnType<typeof openPdf> | null = null;
    void file
      .arrayBuffer()
      .then((bytes) => {
        if (!alive) throw new Error("cancelado");
        pdf = openPdf(bytes);
        return pdf.promise;
      })
      .then(async (doc) => {
        if (!alive) return;
        setPreview({ status: "ok", pages: doc.numPages });
        if (canvas.current) await renderPage(doc, 1, canvas.current, 132);
      })
      .catch((e: unknown) => {
        if (alive) setPreview({ status: "none", reason: isPasswordError(e) ? "O PDF tem senha: o servidor vai recusar." : "Sem prévia: o servidor confere o arquivo ao enviar." });
      });
    return () => {
      alive = false;
      pdf?.destroy();
    };
  }, [file]);

  function pick(f: File | undefined) {
    setMsg(null);
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setMsg({ tone: "error", text: "Envie um arquivo PDF." });
      return;
    }
    if (f.size > MAX) {
      setMsg({ tone: "error", text: "O PDF passa de 50 MB." });
      return;
    }
    setPreview({ status: "reading" });
    setFile(f);
    if (!name.trim()) setName(f.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " "));
  }

  function send() {
    if (!file || !name.trim()) {
      setMsg({ tone: "error", text: !file ? "Escolha o PDF do produto." : "Informe o nome do produto." });
      return;
    }
    const finalName = name.trim();
    const q = new URLSearchParams({ name: finalName, fileName: file.name });
    const req = new XMLHttpRequest();
    xhr.current = req;
    req.open("POST", `/admin/api/products/upload?${q}`);
    req.setRequestHeader("content-type", "application/pdf");
    req.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded * 100) / e.total));
    req.onload = () => {
      xhr.current = null;
      setProgress(null);
      let body: { error?: string } = {};
      try {
        body = JSON.parse(req.responseText) as { error?: string };
      } catch {
        /* resposta sem JSON (ex.: sessão expirada) */
      }
      if (req.status === 200) {
        reset();
        router.refresh();
        onCreated(finalName);
      } else {
        setMsg({
          tone: "error",
          text: body.error ?? (req.status === 401 || req.responseURL.includes("/admin/login") ? "Sua sessão expirou. Entre de novo." : "Não foi possível enviar o PDF. Tente de novo."),
        });
      }
    };
    req.onerror = () => {
      xhr.current = null;
      setProgress(null);
      setMsg({ tone: "error", text: "A conexão caiu durante o envio. Tente de novo." });
    };
    req.onabort = () => {
      xhr.current = null;
      setProgress(null);
      setMsg({ tone: "error", text: "Envio cancelado." });
    };
    setMsg(null);
    setProgress(0);
    req.send(file);
  }

  const tooMany = preview?.status === "ok" && preview.pages > MAX_PAGES;
  const sent = (progress ?? 0) >= 100;
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) return; // durante o envio, fechar só pelo "Cancelar envio"
        reset();
        onClose();
      }}
      title="Novo produto"
      footer={
        busy ? (
          <button type="button" className={s.btn} onClick={() => xhr.current?.abort()}>
            Cancelar envio
          </button>
        ) : (
          <>
            <button
              type="button"
              className={s.btn}
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={!file || !name.trim() || tooMany} onClick={send}>
              Criar produto
            </button>
          </>
        )
      }
    >
      <div className={s.stack}>
        <label className={s.field}>
          <span className={s.label}>Nome do produto</span>
          <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} disabled={busy} />
        </label>

        {/* O campo de arquivo fica sempre no DOM (testes e teclado o encontram pelo rótulo). */}
        <label
          className={s.drop}
          data-over={over ? "true" : undefined}
          hidden={Boolean(file)}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(e.dataTransfer.files[0]);
          }}
        >
          <Art name="produto" size={64} className={s.dropArt} />
          <b>Arraste o PDF aqui</b>
          <span className={s.hint}>
            ou <u>escolha um arquivo</u> · até 50 MB, sem senha, até 1.000 páginas
          </span>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            className={s.srOnly}
            aria-label="Arquivo PDF do produto"
            disabled={busy}
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </label>

        {file ? (
          <div className={s.uploadCard}>
            <div className={s.uploadPreview} data-state={preview?.status}>
              <canvas ref={canvas} aria-hidden="true" hidden={preview?.status !== "ok"} />
              {preview?.status === "reading" ? <Loader2 size={20} className={s.spin} aria-hidden="true" /> : null}
              {preview?.status === "none" ? <Art name="pdf" size={48} className={s.fileArt} /> : null}
              {preview?.status === "ok" ? <span className={s.uploadPages}>{preview.pages} págs.</span> : null}
            </div>
            <div className={s.uploadInfo}>
              <div className={s.uploadFile}>
                <span>
                  <b>{file.name}</b>
                  <small>
                    {mb(file.size)}
                    {preview?.status === "ok" ? ` · ${preview.pages} ${preview.pages === 1 ? "página" : "páginas"}` : ""}
                  </small>
                </span>
                {!busy ? (
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="Remover arquivo"
                    onClick={() => {
                      setFile(null);
                      setPreview(null);
                      if (input.current) input.current.value = "";
                    }}
                  >
                    <X size={16} />
                  </button>
                ) : null}
              </div>
              <div className={s.uploadBar} role="progressbar" aria-label="Envio do PDF" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? 0} data-active={busy ? "true" : undefined}>
                <i style={{ width: `${progress ?? 0}%` }} />
              </div>
              <ul className={s.uploadSteps}>
                <li data-state={preview?.status === "ok" ? (tooMany ? "error" : "done") : preview?.status === "none" ? "warn" : "doing"}>
                  {preview?.status === "ok" ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : <span aria-hidden="true" />}
                  {preview?.status === "ok"
                    ? tooMany
                      ? `${preview.pages} páginas: o limite é ${MAX_PAGES}.`
                      : `Arquivo lido (${preview.pages} ${preview.pages === 1 ? "página" : "páginas"})`
                    : preview?.status === "none"
                      ? preview.reason
                      : "Lendo o arquivo…"}
                </li>
                <li data-state={busy ? (sent ? "done" : "doing") : "todo"}>
                  {busy && sent ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : <span aria-hidden="true" />}
                  {busy ? (sent ? "Enviado" : `Enviando… ${progress}% (${mb(((progress ?? 0) * file.size) / 100)} de ${mb(file.size)})`) : "Enviar para a loja"}
                </li>
                <li data-state={busy && sent ? "doing" : "todo"}>
                  <span aria-hidden="true" />
                  Conferir o PDF no servidor
                </li>
              </ul>
            </div>
          </div>
        ) : null}
        <Live msg={msg} />
      </div>
    </Dialog>
  );
}
