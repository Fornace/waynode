import { useId, useRef } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  danger?: boolean;
  busy?: boolean;
}

export function ConfirmDialog({ title, description, confirmLabel, onCancel, onConfirm, danger = false, busy = false }: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const requestCancel = () => { if (!busy) onCancel(); };
  useEscapeToClose(requestCancel, overlayRef);

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={requestCancel}>
      <section
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={requestCancel} disabled={busy} autoFocus>Cancel</button>
          <button type="button" className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
