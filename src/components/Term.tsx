"use client";

import { useEffect, useRef, useState } from "react";
import { TERM_MAP } from "@/lib/glossary";

/** A jargon word that explains itself on click. */
export function Term({ k, children }: { k: string; children?: React.ReactNode }) {
  const t = TERM_MAP.get(k);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!t) return <>{children ?? k}</>;
  return (
    <span ref={ref} className="relative inline">
      <button type="button" className="term" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {children ?? t.title}
      </button>
      {open && (
        <span className="absolute left-0 top-full z-40 mt-2 block w-72 rounded-xl border border-line bg-panel p-3 text-left text-[13px] font-normal leading-relaxed text-ink-2 shadow-2xl">
          <span className="mb-1 block text-sm font-semibold text-ink">{t.title}</span>
          <span className="block">{t.what}</span>
          <span className="mt-1.5 block"><b className="text-ink">怎么看：</b>{t.how}</span>
          {t.trap && <span className="mt-1.5 block"><b className="text-warn">常见误区：</b>{t.trap}</span>}
        </span>
      )}
    </span>
  );
}
