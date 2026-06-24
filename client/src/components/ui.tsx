// client/src/components/ui.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { User as UserIcon, X, type LucideIcon } from 'lucide-react';
import { statusStyle } from '../lib/format';
import { freshness } from '../lib/metrics';

interface StatusPillProps {
  status?: string | null;
}

export function StatusPill({ status }: StatusPillProps) {
  const s = statusStyle(status);
  return (
    <span className="pill" style={{ background: s.bg, color: s.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

interface FreshnessPillProps {
  lastSeenAt?: string | Date | null;
  className?: string;
}

// Data-freshness indicator derived from the last reading time. Pulses while live.
export function FreshnessPill({ lastSeenAt, className = '' }: FreshnessPillProps) {
  const f = freshness(lastSeenAt);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${className}`}
      style={{ color: f.color }}
      title={lastSeenAt ? new Date(lastSeenAt).toLocaleString('en-IN') : 'No readings yet'}
    >
      <span className={`w-2 h-2 rounded-full ${f.pulse ? 'live-dot' : ''}`} style={{ background: f.color }} />
      {f.label}
    </span>
  );
}

interface LiveDotProps {
  active?: boolean;
}

export function LiveDot({ active }: LiveDotProps) {
  return (
    <span
      className={`w-2 h-2 rounded-full ${active ? 'live-dot' : ''}`}
      style={{ background: active ? '#0D9488' : '#CBD5E1' }}
    />
  );
}

interface AvatarProps {
  src?: string | null;        // profile photo data URL (from the DB)
  name?: string | null;       // used for the initials fallback + alt text
  size?: number;              // px
  color?: string;             // optional accent for the fallback circle (preserves per-site look)
  fallback?: 'initials' | 'icon'; // what to show when there's no photo
  interactive?: boolean;          // when false, render a plain avatar (no hover preview / click-to-zoom)
  className?: string;
}

// One avatar everywhere: shows the employee's photo if set, otherwise their initials
// (or a person icon). When a photo IS set:
//   • HOVER  → a slightly-enlarged circular preview floats above the avatar
//   • CLICK  → a large circular view opens (lightbox)
// Both are rendered in a portal so they're never clipped by tables/cards, and the
// click is isolated from any parent row/button so it only opens the photo.
export function Avatar({ src, name, size = 32, color, fallback = 'initials', interactive = true, className = '' }: AvatarProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<{ cx: number; top: number; bottom: number } | null>(null);
  const [open, setOpen] = useState(false);
  const box = { width: size, height: size };

  const showHover = () => {
    if (!src) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setAnchor({ cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  };
  const hideHover = () => setAnchor(null);

  const inner = src ? (
    <img src={src} alt={name || 'Profile photo'} style={box} className="rounded-full object-cover border border-line block" />
  ) : fallback === 'icon' ? (
    <span style={color ? { ...box, background: `${color}22`, color } : box} className={`rounded-full flex items-center justify-center ${color ? '' : 'bg-accent/15 text-accent'}`}>
      <UserIcon size={Math.round(size * 0.5)} />
    </span>
  ) : (
    <span
      style={color ? { ...box, background: `${color}22`, color, fontSize: Math.round(size * 0.36) } : { ...box, fontSize: Math.round(size * 0.36) }}
      className={`rounded-full flex items-center justify-center font-semibold ${color ? '' : 'bg-accent/15 text-accent'}`}
    >
      {(name || '?').slice(0, 2).toUpperCase()}
    </span>
  );

  // Non-interactive mode — for use inside clickable rows/buttons where a hover
  // preview or click-to-zoom would hijack the parent's click. Pure presentation.
  if (!interactive) return <span className={`inline-flex shrink-0 ${className}`}>{inner}</span>;

  return (
    <span
      ref={ref}
      onMouseEnter={showHover}
      onMouseLeave={hideHover}
      onClick={src ? (e) => { e.stopPropagation(); e.preventDefault(); setAnchor(null); setOpen(true); } : undefined}
      title={src ? 'Click to enlarge' : undefined}
      className={`inline-flex shrink-0 ${src ? 'cursor-zoom-in' : ''} ${className}`}
    >
      {inner}
      {src && anchor && !open && <AvatarHoverCircle src={src} anchor={anchor} />}
      {src && open && <AvatarLightbox src={src} name={name} onClose={() => setOpen(false)} />}
    </span>
  );
}

// Small circular hover preview floating just above (or below) the avatar.
function AvatarHoverCircle({ src, anchor }: { src: string; anchor: { cx: number; top: number; bottom: number } }) {
  const D = 112; // diameter
  const above = anchor.top >= D + 14;
  const top = above ? anchor.top - D - 8 : anchor.bottom + 8;
  const left = Math.max(8, Math.min(anchor.cx - D / 2, window.innerWidth - D - 8));
  return createPortal(
    <div style={{ position: 'fixed', left, top, width: D, height: D, zIndex: 70 }} className="pointer-events-none">
      <img src={src} alt="" className="w-full h-full rounded-full object-cover border-2 border-surface shadow-xl ring-1 ring-line" />
    </div>,
    document.body,
  );
}

// Large circular photo view, opened by clicking an avatar. Closes on backdrop click,
// the ✕ button, or Escape.
function AvatarLightbox({ src, name, onClose }: { src: string; name?: string | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div onClick={(e) => e.stopPropagation()} className="relative flex flex-col items-center">
        <button onClick={onClose} aria-label="Close" className="absolute -top-2 -right-2 z-10 bg-surface border border-line rounded-full p-1.5 text-steel hover:text-primary shadow">
          <X size={16} />
        </button>
        <img
          src={src}
          alt={name || 'Profile photo'}
          className="rounded-full object-cover border-4 border-surface shadow-2xl"
          style={{ width: 'min(80vw, 320px)', height: 'min(80vw, 320px)' }}
        />
        {name && <div className="text-sm text-center text-white font-medium mt-3">{name}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
  icon?: LucideIcon;
}

export function StatCard({ label, value, sub, accent = '#64748B', icon: Icon }: StatCardProps) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <span className="label">{label}</span>
        {Icon && <Icon size={15} className="text-steel" />}
      </div>
      <div className="data text-2xl font-bold mt-2" style={{ color: accent }}>{value}</div>
      {sub && <div className="text-xs text-steel mt-1">{sub}</div>}
    </div>
  );
}

interface SpinnerProps {
  label?: ReactNode;
}

export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <div className="flex items-center gap-2 text-steel text-sm py-8 justify-center">
      <span className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
      {label}…
    </div>
  );
}

type BadgeColor = 'accent' | 'idle' | 'stopped' | 'steel';

interface BadgeProps {
  children: ReactNode;
  color?: BadgeColor;
}

export function Badge({ children, color = 'accent' }: BadgeProps) {
  const map: Record<BadgeColor, string> = {
    accent: 'bg-accent/10 text-accent',
    idle: 'bg-idle/10 text-idle',
    stopped: 'bg-stopped/10 text-stopped',
    steel: 'bg-line text-steel',
  };
  return <span className={`pill ${map[color] || map.steel}`}>{children}</span>;
}
