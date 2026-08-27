// server/src/config/lineLinks.ts
// Machines that finish what another machine started.
//
// BOTTOMMILLING03 reports no piece counter of its own — its PLC publishes
// feed speed and torque, nothing that counts. But the pieces it mills are
// exactly the pieces the machine upstream counted, arriving about two minutes
// later down the line. So its production is that upstream count, shifted by
// the transit time.
//
// BOTTOMMILLING04 used to be here too (borrowing from SPG08) — it was DELINKED
// on 27 Aug 2026 the day its PLC started publishing PROD_COUNT: a machine that
// counts its own work never borrows.
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
  eq(lineLinkFor('BOTTOMMILLING03')?.source, 'HYDRAULICPRESS02', 'exact code');
  eq(lineLinkFor('bottom-milling 03')?.source, 'HYDRAULICPRESS02', 'punctuation + case');
  eq(lineLinkFor('BOTTOMMILLING04'), null, 'delinked: it counts its own work now');
  eq(lineLinkFor('BOTTOMMILLING2'), null, 'unlinked machine stays unlinked');
  eq(normRef('SPG-08') === normRef('SPG08'), true, 'hyphen variant matches');
  console.log('lineLinks: all checks passed');
}
