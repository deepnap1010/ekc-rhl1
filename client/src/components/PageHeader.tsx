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
    <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-line px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 shadow-sm">
      <div className="min-w-0">
        <h1 className="text-lg sm:text-xl font-semibold text-primary truncate">{title}</h1>
        {subtitle && <p className="text-xs text-steel mt-0.5 truncate">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 sm:gap-4 flex-wrap justify-end">
        {live !== undefined && (
          <div className="flex items-center gap-1.5 text-xs">
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
