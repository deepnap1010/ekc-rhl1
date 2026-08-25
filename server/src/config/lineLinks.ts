// server/src/config/lineLinks.ts
// Machines that finish what another machine started.
//
// BOTTOMMILLING03 and BOTTOMMILLING04 report no piece counter of their own —
// their PLCs publish cut depth and feed speed, nothing that counts. But the
// pieces they mill are exactly the pieces the machine upstream of them counted,
// arriving about two minutes later down the line. So their production is that
// upstream count, shifted by the transit time.
//
// This is borrowed, not measured: every surface that shows the number also
// shows which machine counted it, because a card reading "34 pcs" with no
// source would claim this machine counts pieces, and it does not.
export interface LineLink {
  source: string;    // machine whose counter feeds this one
  delayMs: number;   // how long a piece takes to get here
}

const MIN = 60_000;

// Keyed by machine code, matched loosely (SPG08 === SPG-08 === spg 08).
const LINKS: Record<string, LineLink> = {
  BOTTOMMILLING04: { source: 'SPG08',            delayMs: 2 * MIN },
  BOTTOMMILLING03: { source: 'HYDRAULICPRESS02', delayMs: 2 * MIN },
};

/** Codes differ by punctuation across collector versions (SPG-08 vs SPG08), so
 *  every comparison goes through this. */
export const normRef = (s: string): string => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const BY_NORM: Record<string, LineLink> = Object.fromEntries(
  Object.entries(LINKS).map(([code, link]) => [normRef(code), link]),
);

export const lineLinkFor = (ref: string): LineLink | null => BY_NORM[normRef(ref)] ?? null;

// Self-check
if (process.argv[1]?.includes('lineLinks')) {
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  eq(lineLinkFor('BOTTOMMILLING04')?.source, 'SPG08', 'exact code');
  eq(lineLinkFor('bottom-milling 04')?.source, 'SPG08', 'punctuation + case');
  eq(lineLinkFor('BOTTOMMILLING02'), null, 'unlinked machine stays unlinked');
  eq(normRef('SPG-08') === normRef('SPG08'), true, 'hyphen variant matches');
  console.log('lineLinks: all checks passed');
}
