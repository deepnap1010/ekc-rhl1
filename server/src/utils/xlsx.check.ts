// Self-check for the .xlsx writer. Run: npx tsx server/src/utils/xlsx.check.ts [out.xlsx]
// Structural checks here; open the optional output file in Excel/LibreOffice
// (or python -c "import openpyxl; ...") to eyeball formats.
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { buildXlsx, colLetters, crc32, dateCell, excelDate, firstDataRow, zip } from './xlsx.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const throws = (what: string, fn: () => unknown, needle: string): void => {
  try { fn(); } catch (e) { if (String(e).includes(needle)) return; throw new Error(`${what}: threw the wrong error: ${String(e)}`); }
  throw new Error(`${what}: did not throw`);
};
/** Pull one part back out of the package. */
const part = (book: Buffer, name: string): string => {
  let off = 0;
  while (off < book.length && book.readUInt32LE(off) === 0x04034b50) {
    const nameLen = book.readUInt16LE(off + 26), extraLen = book.readUInt16LE(off + 28), packed = book.readUInt32LE(off + 18);
    const n = book.toString('utf8', off + 30, off + 30 + nameLen);
    const data = book.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + packed);
    if (n === name) return inflateRawSync(data).toString('utf8');
    off += 30 + nameLen + extraLen + packed;
  }
  throw new Error(`${name} not found`);
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
eq('a date cell is a whole serial on the plant clock', excelDate((dateCell(2026, 9, 1, 330) as { v: Date }).v, 330), 46266);
eq('first data row: title + note + bands + header', firstDataRow({ title: 't', note: 'n', bands: [{ label: 'b', span: 1 }] }), 5);
eq('first data row: bare block', firstDataRow({}), 2);

const z = zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'd/b.txt', data: Buffer.alloc(0) }]);
eq('zip starts with a local header', z.readUInt32LE(0), 0x04034b50);
eq('zip ends with the EOCD record', z.readUInt32LE(z.length - 22), 0x06054b50);
eq('two entries', z.readUInt16LE(z.length - 22 + 10), 2);

const book = buildXlsx([
  { name: 'Summary', blocks: [
    { title: 'Report', columns: [{ header: 'Metric', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 20 }],
      rows: [{ k: 'Production', v: { v: 1234, fmt: 'int' } }, { k: 'Availability', v: { v: 0.734, fmt: 'pct' } }, { k: 'Runtime', v: { v: 5.5 * 3600_000, fmt: 'dur' } }, { k: 'Generated', v: { v: new Date('2026-09-19T05:30:00Z'), fmt: 'datetime' } }] },
    { title: 'By family', columns: [{ header: 'Family', key: 'f' }, { header: 'Pieces', key: 'n', fmt: 'int' }], rows: [{ f: 'SPG', n: 10 }, { f: 'Cutting <&>', n: 2 }] },
    { title: 'Note only', note: 'no table under this one', columns: [], rows: [] },
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
      { header: dateCell(2026, 9, 1, 330), key: 'd1', fmt: 'int', style: 'input' },
      { header: dateCell(2026, 9, 2, 330), key: 'd2', fmt: 'int', style: 'input' },
      { header: dateCell(2026, 9, 3, 330), key: 'd3', fmt: 'int', style: 'input' },
      { header: 'TOTAL', key: 't', fmt: 'int', style: 'bold' },
    ],
    rows: [
      { m: 'PC05', d1: 10, d2: 12, d3: 9, t: { f: 'SUM({col:d1}{row}:{col:d3}{row})', v: 31 } },
      { m: 'PC06', d1: 7, d2: 0, d3: 4, t: { f: 'SUM({col:d1}{row}:{col:d3}{row})', v: 11 } },
      { __style: 'total', m: 'TOTAL', d1: { f: 'SUM({col:d1}{first}:{col:d1}{last})' }, d2: { f: 'SUM({col:d2}{first}:{col:d2}{last})' }, d3: null, t: { f: 'SUM({col:t}{first}:{col:t}{last})', v: 42 } },
    ],
  }] },
], 330);
eq('a workbook is a zip', book.readUInt32LE(0), 0x04034b50);
eq('nine parts for three sheets', book.readUInt16LE(book.length - 22 + 10), 9);
const grid = part(book, 'xl/worksheets/sheet3.xml');
eq('the TOTAL row sums the data rows only', /SUM\(B4:B5\)/.test(grid), true);
eq('a blank in a styled row is still a styled cell', /<c r="D6" s="\d+"\/>/.test(grid), true);
eq('a cached value rides with its formula', /<c r="E4" s="\d+"><f>SUM\(B4:D4\)<\/f><v>31<\/v><\/c>/.test(grid), true);
eq('the filter stops before the TOTAL row', /<autoFilter ref="A3:E5"\/>/.test(grid), true);
eq('the frozen pane is bottom-right when both splits are set', /activePane="bottomRight"/.test(grid), true);
const summary = part(book, 'xl/worksheets/sheet1.xml');
eq('a note-only block has no header row', (summary.match(/<row /g) || []).length, (1 + 1 + 4) + (1 + 1 + 2) + (1 + 1));   // report: title,header,4 rows · family: title,header,2 · note-only: title,note (spacer rows are not emitted)
eq('print titles name the landscape sheet', /_xlnm\.Print_Titles" localSheetId="2">'Grid'!\$1:\$3</.test(part(book, 'xl/workbook.xml')), true);

// The plant's own conventions render: whole percents, the light-red delay
// band, the yellow grand row, and a SUMIF over {first}:{last} that stops
// before both the section TOTAL and the grand TOTAL.
const two = buildXlsx([{ name: 'S', blocks: [{
  bands: [{ label: 'X', span: 1 }, { label: 'DELAY', span: 2, style: 'delay' }],
  columns: [{ header: 'k', key: 'k' }, { header: 'p', key: 'p', fmt: 'pct0' }, { header: 'h', key: 'h', fmt: 'dec1', style: 'delay' }],
  rows: [{ k: 'a', p: 0.5, h: 1.5 }, { k: 'b', p: 0.25, h: 2 }, { __style: 'total', k: 'T', h: { f: 'SUMIF({col:k}{first}:{col:k}{last},"a",{col:h}{first}:{col:h}{last})' } }, { __style: 'grand', k: 'G', h: { f: 'SUM({col:h}{first}:{col:h}{last})' } }],
}] }], 330);
const s1 = part(two, 'xl/worksheets/sheet1.xml');
eq('SUMIF spans the data rows only', /SUMIF\(A3:A4,&quot;a&quot;,C3:C4\)/.test(s1), true);
eq('the grand row is outside {first}:{last} too', /<c r="C6" s="\d+"><f>SUM\(C3:C4\)<\/f><\/c>/.test(s1), true);
eq('the band merges its two cells', /<mergeCell ref="B1:C1"\/>/.test(s1), true);
eq('pct0 lands on its own xf', s1.includes(`<c r="B3" s="${3 + 1 * 9 + 5}">`), true);   // style 'cell' (1) × fmt 'pct0' (5)
eq('delay style on the hours column', s1.includes(`<c r="C3" s="${3 + 7 * 9 + 3}">`), true);   // style 'delay' (7) × fmt 'dec1' (3)
eq('grand style is the last one', s1.includes(`<c r="A6" t="inlineStr" s="${3 + 9 * 9 + 0}">`), true);
eq('styles carry the derived counts', /<fills count="8">/.test(part(two, 'xl/styles.xml')) && /<numFmts count="8">/.test(part(two, 'xl/styles.xml')), true);

throws('an unknown column key throws', () => buildXlsx([{ name: 'S', blocks: [{ columns: [{ header: 'a', key: 'a' }], rows: [{ a: { f: 'SUM({col:nope}{row})' } }] }] }]), 'unknown column key "nope"');
throws('bands wider than the block throw', () => buildXlsx([{ name: 'S', blocks: [{ bands: [{ label: 'x', span: 2 }], columns: [{ header: 'a', key: 'a' }], rows: [] }] }]), 'bands span 2 columns');

const out = process.argv[2];
if (out) { writeFileSync(out, book); console.log('wrote', out, book.length, 'bytes'); }
console.log('xlsx: all checks passed');
