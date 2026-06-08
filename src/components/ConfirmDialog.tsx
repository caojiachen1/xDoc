import { Dismiss24Regular } from "@fluentui/react-icons";
import { AlertTriangle } from "lucide-react";
import "./ConfirmDialog.css";

interface Props {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function ConfirmDialog({
  open,
  title = "确认",
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  onClose,
  onConfirm,
}: Props) {
  if (!open) return null;

  return (
    <div className="cd-overlay" onClick={onClose}>
      <div className="cd-window" onClick={e => e.stopPropagation()}>
        <div className="cd-header">
          <div className="cd-header-title">
            {danger && <AlertTriangle size={16} className="cd-warn-icon" />}
            {title}
          </div>
          <button className="cd-close-btn" onClick={onClose}>
            <Dismiss24Regular />
          </button>
        </div>
        <div className="cd-body">
          <p className="cd-message">{message}</p>
        </div>
        <div className="cd-footer">
          <button
            className={`cd-btn ${danger ? "cd-btn-danger" : "cd-btn-primary"}`}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
          <button className="cd-btn cd-btn-cancel" onClick={onClose}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
