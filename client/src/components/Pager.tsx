// client/src/components/Pager.tsx
// One pager for every list in the app: rows-per-page + Prev/Next + where you are.
// Lists that page through a server endpoint all had their own copy of this
// markup, each with a different page size baked in.
import { fmtNum } from '../lib/format';

export const PAGE_SIZES = [10, 20, 25, 40, 80, 100];
export const DEFAULT_PAGE_SIZE = 25;

interface PagerProps {
  page: number;
  size: number;
  onPage: (p: number) => void;
  onSize: (n: number) => void;
  /** Rows the filter matches. */
  total?: number;
  /** false when `total` is only what has been found so far — the pager then
   *  offers Next instead of inventing a page count. */
  exact?: boolean;
  hasMore?: boolean;
  loading?: boolean;
  noun?: string;
}

export default function Pager({
  page, size, onPage, onSize, total, exact = true, hasMore, loading, noun = 'rows',
}: PagerProps) {
  const known = exact && typeof total === 'number';
  const pageCount = known ? Math.max(1, Math.ceil((total as number) / size)) : null;
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = known ? Math.min(page * size, total as number) : page * size;
  const canNext = pageCount ? page < pageCount : !!hasMore;

  return (
    <div className="flex items-center justify-between gap-3 text-sm flex-wrap">
      <div className="flex items-center gap-2 text-xs text-steel">
        <label htmlFor="pager-size">Rows</label>
        <select
          id="pager-size"
          value={size}
          onChange={(e) => { onSize(Number(e.target.value)); onPage(1); }}
          className="bg-surface border border-line rounded-lg px-2 py-1.5 text-xs outline-none focus:border-accent/50"
        >
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span>
          {typeof total === 'number'
            ? `${fmtNum(first)}–${fmtNum(last)} of ${known ? '' : 'at least '}${fmtNum(total)} ${noun}`
            : ''}
        </span>
        {loading && <span className="text-accent">Loading…</span>}
      </div>

      <div className="flex items-center gap-2">
        <button
          disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-base"
        >Prev</button>
        <span className="px-2 py-1.5 text-steel text-xs">
          Page <span className="data">{page}</span>{pageCount ? <> of <span className="data">{pageCount}</span></> : null}
        </span>
        <button
          disabled={!canNext} onClick={() => onPage(page + 1)}
          className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-base"
        >Next</button>
      </div>
    </div>
  );
}
