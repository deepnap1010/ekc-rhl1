// client/src/components/Modal.tsx — accessible centered modal with backdrop + Esc close.
// Rendered through a PORTAL onto document.body: `position: fixed` is measured
// against the nearest ancestor with a transform/backdrop-filter, and this app's
// sticky page headers use backdrop-blur — a modal opened from inside one (the
// machine header's DIA chip) was trapped and clipped inside that header instead
// of covering the screen.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  children: ReactNode;
  maxW?: string;
}

// Modals can nest (production history → correction form). Only the TOPMOST
// answers Escape, and the page's scroll lock lifts when the last one closes —
// a single-modal assumption closed both on one keypress and unlocked the page
// under a still-open list.
const open: object[] = [];

export default function Modal({ title, subtitle, icon: Icon, onClose, children, maxW = 'max-w-3xl' }: ModalProps): JSX.Element {
  const [id] = useState(() => ({}));
  // Two effects on purpose: the stack must not re-push when onClose identity
  // changes on a parent re-render, or the outer would jump back on top.
  useEffect(() => {
    open.push(id);
    document.body.style.overflow = 'hidden';
    return () => { open.splice(open.indexOf(id), 1); if (!open.length) document.body.style.overflow = ''; };
  }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open[open.length - 1] === id) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, id]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-4 bg-slate-900/50 backdrop-blur-sm overflow-y-auto" onClick={onClose}>
      <div className={`panel w-full ${maxW} my-4 sm:my-8 max-h-[90vh] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Icon size={16} className="text-accent" /></span>}
            <div className="min-w-0">
              <h2 className="font-semibold text-primary truncate">{title}</h2>
              {subtitle && <p className="text-xs text-steel truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} className="text-steel hover:text-primary p-1 -mr-1 shrink-0" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
