// client/src/components/PageHeader.tsx
import { useEffect, useState, type ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  live?: number;
  right?: ReactNode;
}

export default function PageHeader({ title, subtitle, live, right }: PageHeaderProps) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-line px-4 sm:px-6 py-4 flex items-center justify-between gap-3 shadow-sm">
      <div>
        <h1 className="text-xl font-semibold text-primary">{title}</h1>
        {subtitle && <p className="text-xs text-steel mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-4">
        {live !== undefined && (
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-accent live-dot" />
            <span className="text-steel">{live} live</span>
          </div>
        )}
        <span className="data text-xs text-steel">{now.toLocaleTimeString('en-IN')}</span>
        {right}
      </div>
    </div>
  );
}
