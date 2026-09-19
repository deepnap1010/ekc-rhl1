// Self-check for the .xlsx writer. Run: npx tsx server/src/utils/xlsx.check.ts [out.xlsx]
// Structural checks here; open the optional output file in Excel/LibreOffice
// (or python -c "import openpyxl; ...") to eyeball formats.
import { writeFileSync } from 'node:fs';
import { buildXlsx, colLetters, crc32, excelDate, zip } from './xlsx.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

eq('A', colLetters(0), 'A');
eq('Z', colLetters(25), 'Z');
eq('AA', colLetters(26), 'AA');
eq('AZ', colLetters(51), 'AZ');
eq('BA', colLetters(52), 'BA');
eq('crc32 of the reference string', crc32(Buffer.from('123456789')), 0xCBF43926);
eq('crc32 of nothing', crc32(Buffer.alloc(0)), 0);
eq('epoch is serial 25569', excelDate(new Date(0), 0), 25569);
eq('IST shifts the serial by 5h30', excelDate(new Date(0), 330), 25569 + 330 / 1440);
eq('a bad date is null', excelDate('nonsense', 0), null);

const z = zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'd/b.txt', data: Buffer.alloc(0) }]);
eq('zip starts with a local header', z.readUInt32LE(0), 0x04034b50);
eq('zip ends with the EOCD record', z.readUInt32LE(z.length - 22), 0x06054b50);
eq('two entries', z.readUInt16LE(z.length - 22 + 10), 2);

const book = buildXlsx([
  { name: 'Summary', blocks: [
    { title: 'Report', columns: [{ header: 'Metric', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 20 }],
      rows: [{ k: 'Production', v: { v: 1234, fmt: 'int' } }, { k: 'Availability', v: { v: 0.734, fmt: 'pct' } }, { k: 'Runtime', v: { v: 5.5 * 3600_000, fmt: 'dur' } }, { k: 'Generated', v: { v: new Date('2026-09-19T05:30:00Z'), fmt: 'datetime' } }] },
    { title: 'By family', columns: [{ header: 'Family', key: 'f' }, { header: 'Pieces', key: 'n', fmt: 'int' }], rows: [{ f: 'SPG', n: 10 }, { f: 'Cutting <&>', n: 2 }] },
  ] },
  { name: 'Machines [bad:name]', blocks: [{ columns: [{ header: 'Machine', key: 'm' }, { header: 'Idle', key: 'i', fmt: 'dur' }, { header: 'Live', key: 'l' }], rows: [{ m: 'PC07', i: 600_000, l: true }, { m: 'SPG02', i: 0, l: false }, { m: 'X', i: Number.NaN, l: null }] }] },
  // The plant's grid: bands over shift columns, date headers, yellow inputs,
  // a TOTAL column and a TOTAL row as live formulas, frozen first column,
  // landscape.
  { name: 'Grid', landscape: true, blocks: [{
    title: 'PRODUCTION — SEPT 2026', freezeCols: 1,
    bands: [{ label: '', span: 1 }, { label: 'Pieces', span: 3 }, { label: '', span: 1 }],
    columns: [
      { header: 'Machine', key: 'm', width: 14 },
      { header: { v: new Date('2026-09-01T00:00:00Z'), fmt: 'date' }, key: 'd1', fmt: 'int', style: 'input' },
      { header: { v: new Date('2026-09-02T00:00:00Z'), fmt: 'date' }, key: 'd2', fmt: 'int', style: 'input' },
      { header: { v: new Date('2026-09-03T00:00:00Z'), fmt: 'date' }, key: 'd3', fmt: 'int', style: 'input' },
      { header: 'TOTAL', key: 't', fmt: 'int', style: 'bold' },
    ],
    rows: [
      { m: 'PC05', d1: 10, d2: 12, d3: 9, t: { f: 'SUM({col:d1}{row}:{col:d3}{row})' } },
      { m: 'PC06', d1: 7, d2: 0, d3: 4, t: { f: 'SUM({col:d1}{row}:{col:d3}{row})' } },
      { __style: 'total', m: 'TOTAL', d1: { f: 'SUM({col:d1}{first}:{col:d1}{last})' }, d2: { f: 'SUM({col:d2}{first}:{col:d2}{last})' }, d3: { f: 'SUM({col:d3}{first}:{col:d3}{last})' }, t: { f: 'SUM({col:t}{first}:{col:t}{last})', v: 42 } },
    ],
  }] },
], 330);
eq('a workbook is a zip', book.readUInt32LE(0), 0x04034b50);
eq('eight parts for three sheets', book.readUInt16LE(book.length - 22 + 10), 8);

// The plant's own conventions render: whole percents, the light-red delay
// band, and a SUMIF over {first}:{last} that stops before the TOTAL rows.
const two = buildXlsx([{ name: 'S', blocks: [{
  bands: [{ label: 'X', span: 1 }, { label: 'DELAY', span: 2, style: 'delay' }],
  columns: [{ header: 'k', key: 'k' }, { header: 'p', key: 'p', fmt: 'pct0' }, { header: 'h', key: 'h', fmt: 'dec1', style: 'delay' }],
  rows: [{ k: 'a', p: 0.5, h: 1.5 }, { k: 'b', p: 0.25, h: 2 }, { __style: 'total', k: 'T', h: { f: 'SUMIF({col:k}{first}:{col:k}{last},"a",{col:h}{first}:{col:h}{last})' } }],
}] }], 330);
const { inflateRawSync } = await import('node:zlib');
// Pull sheet1.xml back out of the package to look at what was written.
const sheetXml = ((): string => {
  let off = 0;
  while (off < two.length && two.readUInt32LE(off) === 0x04034b50) {
    const nameLen = two.readUInt16LE(off + 26), extraLen = two.readUInt16LE(off + 28), packed = two.readUInt32LE(off + 18);
    const name = two.toString('utf8', off + 30, off + 30 + nameLen);
    const data = two.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + packed);
    if (name === 'xl/worksheets/sheet1.xml') return inflateRawSync(data).toString('utf8');
    off += 30 + nameLen + extraLen + packed;
  }
  throw new Error('sheet1.xml not found');
})();
eq('SUMIF spans the data rows only', /SUMIF\(A3:A4,&quot;a&quot;,C3:C4\)/.test(sheetXml), true);
eq('the band merges its two cells', /<mergeCell ref="B1:C1"\/>/.test(sheetXml), true);
eq('pct0 lands on its own xf', sheetXml.includes(`<c r="B3" s="${3 + 1 * 9 + 5}">`), true);   // style 'cell' (1) × fmt 'pct0' (5)
eq('delay style on the hours column', sheetXml.includes(`<c r="C3" s="${3 + 7 * 9 + 3}">`), true);   // style 'delay' (7) × fmt 'dec1' (3)
const out = process.argv[2];
if (out) { writeFileSync(out, book); console.log('wrote', out, book.length, 'bytes'); }
console.log('xlsx: all checks passed');
