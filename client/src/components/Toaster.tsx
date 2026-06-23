// client/src/components/Toaster.tsx
// Renders the global toast stack (top-right). Each toast slides in, shows a type
// icon + message + close button, and auto-dismisses with a depleting progress
// bar. Mounted once at the app root so it survives route changes.
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Info, X, type LucideIcon } from 'lucide-react';
import { useToastStore, type Toast, type ToastType } from '../store/toast';

const STYLES: Record<ToastType, { Icon: LucideIcon; color: string }> = {
  success: { Icon: CheckCircle2, color: '#16A34A' },
  error: { Icon: XCircle, color: '#DC2626' },
  info: { Icon: Info, color: '#2563EB' },
};

export default function Toaster(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />)}
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }): JSX.Element {
  const { Icon, color } = STYLES[toast.type] || STYLES.info;
  const [shown, setShown] = useState(false);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    const raf = requestAnimationFrame(() => { setShown(true); setProgress(0); });
    const timer = setTimeout(onClose, toast.duration);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`pointer-events-auto relative bg-surface border border-line rounded-lg shadow-lg overflow-hidden transition-all duration-300 ${
        shown ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'
      }`}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Icon size={18} style={{ color }} className="shrink-0" />
        <span className="text-sm text-primary flex-1">{toast.message}</span>
        <button onClick={onClose} className="text-steel hover:text-primary shrink-0"><X size={15} /></button>
      </div>
      <div
        className="absolute bottom-0 left-0 h-1 rounded-full"
        style={{ width: `${progress}%`, background: color, transition: `width ${toast.duration}ms linear` }}
      />
    </div>
  );
}
