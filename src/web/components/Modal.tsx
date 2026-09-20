import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.js";

export function Modal({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? "modal-wide" : ""}`}
    aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-header"><h2>{title}</h2>
      <button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close" /></button>
    </div>
    {children}
  </dialog>;
}
