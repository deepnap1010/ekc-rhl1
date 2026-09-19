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
], 330);
eq('a workbook is a zip', book.readUInt32LE(0), 0x04034b50);
eq('seven parts for two sheets', book.readUInt16LE(book.length - 22 + 10), 7);
const out = process.argv[2];
if (out) { writeFileSync(out, book); console.log('wrote', out, book.length, 'bytes'); }
console.log('xlsx: all checks passed');
