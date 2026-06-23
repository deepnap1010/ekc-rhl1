// client/src/components/Sparkline.tsx
// Tiny dependency-free trend line for a numeric series. Auto-scales to its own
// min/max, draws a faint area fill + line + a dot on the latest point. The SVG
// fills its container width (viewBox + preserveAspectRatio). Faulty sentinel
// values should be stripped by the caller before passing `data`.
interface SparklineProps {
  data?: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Sparkline({
  data = [],
  width = 160,
  height = 34,
  color = '#0D9488',
  strokeWidth = 1.5,
}: SparklineProps): JSX.Element {
  const pts = (data || []).map(Number).filter((v) => Number.isFinite(v));
  if (pts.length < 2) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-[10px] text-steel/40">—</div>
    );
  }

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const pad = 3;
  const stepX = width / (pts.length - 1);
  const y = (v: number): number => height - pad - ((v - min) / range) * (height - pad * 2);

  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L${width.toFixed(2)},${height} L0,${height} Z`;
  const lastX = (pts.length - 1) * stepX;
  const lastY = y(pts[pts.length - 1]);
  const gid = `spark-${color.replace('#', '')}`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block overflow-visible"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}
