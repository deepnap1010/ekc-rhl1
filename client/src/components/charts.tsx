// client/src/components/charts.tsx
// Lightweight, dependency-free SVG charts for the analysis consoles:
//   • Donut    — full ring, proportional segments, value in the centre
//   • Gauge    — 180° semicircle, same segment model, total in the centre
//   • Legend   — colour-coded rows (label · value · %) that drive both
// Hand-rolled (like PressureRing) so there are no Recharts layout/overflow
// surprises and the geometry is exact. Segments are normalised with pathLength=100
// so a segment's stroke-dasharray IS its percentage of the whole.
import type { ReactNode } from 'react';

const TRACK = '#EEF2F6';

// Brand-aligned palettes shared with the Reports + Dashboard pages.
export const ERROR_COLORS: Record<string, string> = {
  fault: '#DC2626', range: '#F97316', deviation: '#D97706',
  stale: '#6366F1', offline: '#94A3B8', other: '#64748B',
};
export const STATUS_COLORS: Record<string, string> = { running: '#0D9488', idle: '#D97706', stopped: '#DC2626', offline: '#94A3B8' };
export const BLUE_RAMP = ['#0E7490', '#0D9488', '#2563EB', '#3B82F6', '#6366F1', '#8B5CF6', '#60A5FA', '#14B8A6'];
export const PALETTE = ['#0D9488', '#6366F1', '#EC4899', '#D97706', '#3B82F6', '#8B5CF6', '#10B981', '#F43F5E'];

export interface ChartSegment { label?: string; value: number; color: string; }

const sum = (segs: ChartSegment[]): number => segs.reduce((s, x) => s + (Number(x.value) || 0), 0);

// ── Donut — full circle, value in the centre ─────────────────────────────────
export function Donut({ segments = [], size = 196, thickness = 24, children, emptyColor = '#0D9488' }: {
  segments?: ChartSegment[]; size?: number; thickness?: number; children?: ReactNode; emptyColor?: string;
}): JSX.Element {
  const total = sum(segments);
  const r = (size - thickness) / 2;
  const c = size / 2;
  let acc = 0;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke={total ? TRACK : emptyColor} strokeWidth={thickness} opacity={total ? 1 : 0.18} />
        {total > 0 && segments.map((s, i) => {
          const len = (s.value / total) * 100;
          const node = (
            <circle
              key={s.label ?? i} cx={c} cy={c} r={r} fill="none"
              stroke={s.color} strokeWidth={thickness} pathLength={100}
              strokeDasharray={`${len} ${100 - len}`} strokeDashoffset={-acc}
              style={{ transition: 'stroke-dasharray 0.5s ease, stroke-dashoffset 0.5s ease' }}
            />
          );
          acc += len;
          return node;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">{children}</div>
    </div>
  );
}

// ── Gauge — 180° semicircle, total in the centre ─────────────────────────────
export function Gauge({ segments = [], thickness = 22, children }: {
  segments?: ChartSegment[]; thickness?: number; children?: ReactNode;
}): JSX.Element {
  const total = sum(segments);
  // viewBox geometry: a top half-ring centred on (120,120), radius 100.
  const arc = 'M 20 120 A 100 100 0 0 1 220 120';
  let acc = 0;

  return (
    <div className="relative w-full max-w-[300px] mx-auto">
      <svg viewBox="0 0 240 138" className="w-full">
        <path d={arc} fill="none" stroke={TRACK} strokeWidth={thickness} strokeLinecap="round" pathLength={100} />
        {total > 0 && segments.map((s, i) => {
          const len = (s.value / total) * 100;
          const node = (
            <path
              key={s.label ?? i} d={arc} fill="none"
              stroke={s.color} strokeWidth={thickness} pathLength={100}
              strokeDasharray={`${len} ${100 - len}`} strokeDashoffset={-acc}
              strokeLinecap={total && len >= 99.9 ? 'round' : 'butt'}
              style={{ transition: 'stroke-dasharray 0.5s ease, stroke-dashoffset 0.5s ease' }}
            />
          );
          acc += len;
          return node;
        })}
      </svg>
      <div className="absolute inset-x-0 bottom-1 flex flex-col items-center justify-center text-center px-4">{children}</div>
    </div>
  );
}

// ── Legend — colour-coded rows that read out the exact numbers ───────────────
// `scroll` (default) renders EVERY row inside a fixed-height, scrollable box — so it
// stays usable at hundreds of machines. Set `scroll={false}` for a short, fixed list
// (e.g. the 4-status mix): it then caps at `max` rows and shows a "+N more" footer.
export function Legend({ rows = [], total, format = (v) => v, max = 8, scroll = true }: {
  rows?: ChartSegment[]; total?: number; format?: (v: number) => ReactNode; max?: number; scroll?: boolean;
}): JSX.Element {
  const shown = scroll ? rows : rows.slice(0, max);
  const hidden = rows.length - shown.length;
  return (
    <div className={scroll ? 'max-h-[200px] overflow-y-auto pr-1 -mr-1' : ''}>
      <div className="space-y-1.5">
        {shown.map((r, i) => {
          const pct = total ? Math.round((r.value / total) * 100) : 0;
          return (
            <div key={r.label ?? i} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: r.color }} />
              <span className="text-steel truncate flex-1" title={r.label}>{r.label}</span>
              <span className="data text-primary font-medium shrink-0">{format(r.value)}</span>
              <span className="data text-steel/60 w-9 text-right shrink-0">{pct}%</span>
            </div>
          );
        })}
      </div>
      {hidden > 0 && <div className="text-[10px] text-steel/60 mt-2 pt-2 border-t border-line">+{hidden} more</div>}
    </div>
  );
}
