"use client";

// Novo produto (P13): nome + PDF enviado em streaming para a rota autenticada /admin/api/products/upload, com barra de
// progresso (XMLHttpRequest), cancelar e as mensagens de validação do servidor (PDF inválido, criptografado, > 50 MB...).
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { Live } from "../../ui";
import { Art } from "../../blocks";

const MAX = 52_428_800;
const mb = (n: number) => `${(n / 1_048_576).toFixed(1).replace(".", ",")} MB`;

export function ProductUpload() {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

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
    setFile(f);
    if (!name.trim()) setName(f.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " "));
  }

  function send() {
    if (!file || !name.trim()) {
      setMsg({ tone: "error", text: !file ? "Escolha o PDF do produto." : "Informe o nome do produto." });
      return;
    }
    const q = new URLSearchParams({ name: name.trim(), fileName: file.name });
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
        setMsg({ tone: "ok", text: `Produto “${name.trim()}” criado.` });
        setFile(null);
        setName("");
        if (input.current) input.current.value = "";
        router.refresh();
      } else {
        setMsg({ tone: "error", text: body.error ?? (req.status === 401 || req.responseURL.includes("/admin/login") ? "Sua sessão expirou. Entre de novo." : "Não foi possível enviar o PDF. Tente de novo.") });
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

  const busy = progress !== null;
  return (
    <section className={s.card} style={{ maxWidth: 560 }} aria-labelledby="novo-produto">
      <div className={s.cardHead}>
        <h2 id="novo-produto">Novo produto</h2>
      </div>
      <div className={s.stack}>
        <label className={s.field}>
          <span className={s.label}>Nome do produto</span>
          <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} disabled={busy} />
        </label>
        <label
          className={s.drop}
          data-over={over ? "true" : undefined}
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
          <PIcon name="file-up" size={26} />
          <b>Arraste o PDF aqui</b>
          <span className={s.hint}>
            ou <u>escolha um arquivo</u> · até 50 MB, sem senha, até 500 páginas
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
          <div className={s.progress}>
            <Art name="pdf" size={40} className={s.fileArt} />
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</b>
                {busy ? <span className={s.muted}>{progress}%</span> : null}
              </div>
              <div
                className={s.progressBar}
                role="progressbar"
                aria-label="Envio do PDF"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress ?? 0}
              >
                <i style={{ width: `${progress ?? 0}%` }} />
              </div>
              <small className={s.muted}>{busy ? `${mb(((progress ?? 0) * file.size) / 100)} de ${mb(file.size)}` : mb(file.size)}</small>
            </div>
            <button
              type="button"
              className={s.iconBtn}
              aria-label={busy ? "Cancelar envio" : "Remover arquivo"}
              onClick={() => {
                if (xhr.current) xhr.current.abort();
                else {
                  setFile(null);
                  if (input.current) input.current.value = "";
                }
              }}
            >
              <PIcon name="x" />
            </button>
          </div>
        ) : null}
        <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnLg}`} disabled={busy || !file || !name.trim()} onClick={send}>
          {busy ? "Enviando e conferindo o PDF…" : "Criar produto"}
        </button>
        <Live msg={msg} />
      </div>
    </section>
  );
}
