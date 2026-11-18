"use client";

// Partes vivas da página do pedido: polling do status (a cada 3 s, por até 30 min) e o botão de copiar o Pix.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { pollOrderStatus } from "@/lib/order-poll";
import s from "../../(design)/buyer.module.css";
import { Icon } from "../../(design)/icons";

/** Recarrega a página (dados do servidor) quando o status do pedido muda. Não desenha nada. */
export function OrderLive({ publicId, status }: { publicId: string; status: string }) {
  const router = useRouter();
  useEffect(
    () =>
      pollOrderStatus({
        initial: status,
        fetchStatus: async () => {
          const res = await fetch(`/api/orders/${encodeURIComponent(publicId)}/status`, { cache: "no-store" });
          if (!res.ok) return null;
          const body = (await res.json()) as { status?: unknown };
          return typeof body.status === "string" ? body.status : null;
        },
        onChange: () => router.refresh(),
      }),
    [publicId, status, router],
  );
  return null;
}

export function CopyPixButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return (
    <>
      <button type="button" onClick={copy} className={`${s.btn} ${s.btnLg} ${s.btnFull} ${copied ? s.btnSuccess : ""} ${s.mt12}`}>
        <Icon name={copied ? "check" : "copy"} size={20} />
        {copied ? "Código copiado!" : "Copiar código Pix"}
      </button>
      <p className={s.copyHint} aria-live="polite">
        {failed ? "Não deu para copiar sozinho: toque e segure no código acima para copiar." : copied ? "Agora abra o app do seu banco e cole na área Pix." : ""}
      </p>
    </>
  );
}
