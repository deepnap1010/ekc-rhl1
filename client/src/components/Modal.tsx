// client/src/components/Modal.tsx — accessible centered modal with backdrop + Esc close.
import { useEffect, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  children: ReactNode;
  maxW?: string;
}

export default function Modal({ title, subtitle, icon: Icon, onClose, children, maxW = 'max-w-3xl' }: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  return (
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
    </div>
  );
}
