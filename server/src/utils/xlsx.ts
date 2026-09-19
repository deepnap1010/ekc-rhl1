// server/src/utils/xlsx.ts
// A dependency-free .xlsx writer — enough of SpreadsheetML for a plant review
// workbook in the plant's own style: many sheets, a merged title above each
// table, band rows over column groups ("SHIFT-I / SHIFT-II / SHIFT-III"),
// bold shaded headers, bordered cells, yellow "input" cells and green
// "average" cells the way the plant's own workbook colours them, column
// widths, frozen panes, autofilter, landscape fit-to-width printing, real
// number formats (integers with separators, percentages, durations as h:mm,
// dates as d-mmm, date-times), and live formulas for totals so a reviewer can
// still click a cell and see what it sums. Nothing here is exotic: an .xlsx
// is a ZIP of XML parts, and Node ships both the deflate and the byte
// handling. The factory box cannot reach npm, so a library was never an
// option there anyway.
//
// Strings go inline (t="inlineStr") — no shared-string table to build, and a
// 20,000-row sheet is still a few hundred KB once deflated.
//
// Formula tokens: {row} this row, {first}/{last} the block's first and last
// DATA rows (rows styled 'total' or 'grand' are excluded, so a TOTAL row
// summing {first}:{last} never includes itself), {col:KEY} the letter of the
// column with that key (an unknown key throws — a silent column A would sum
// the label column and ship a wrong workbook). A block that interleaves
// section subtotals must NOT sum {first}:{last} for its grand total — that
// counts every subtotal again; list the subtotal rows explicitly instead.
import { deflateRawSync } from 'node:zlib';

export type Fmt = 'text' | 'int' | 'dec' | 'dec1' | 'pct' | 'pct0' | 'dur' | 'datetime' | 'date';
// How a cell looks. 'cell' is the bordered default; 'plain' has no border;
// 'input' is the plant's yellow for typed figures, 'avg' its green for
// averages, 'delay' its light red for idle hours; 'total' is bold on grey
// for section subtotals and 'grand' bold on yellow for the plant TOTAL.
export type Style = 'plain' | 'cell' | 'input' | 'calc' | 'bold' | 'total' | 'avg' | 'delay' | 'header' | 'grand';
export type Scalar = string | number | boolean | Date | null | undefined;
/** A cell: a value, or a value/formula with its own format and style. A
 *  formula is written without '='; a value beside it is the cached result
 *  a reader that does not recalculate on load still shows. */
export type Cell = Scalar | { v?: Scalar; f?: string; fmt?: Fmt; style?: Style };
export type Row = Record<string, Cell> & { __style?: Style };
export interface Column { header: string | Cell; key: string; width?: number; fmt?: Fmt; style?: Style }
export interface Band { label: string; span: number; style?: Style }
export interface Block {
  title?: string;
  note?: string;
  /** A row of merged labels above the headers, e.g. [{label:'Production', span:3}, …]. */
  bands?: Band[];
  /** No columns = a note-only block (title/note, no header row). */
  columns: Column[];
  rows: Row[];
  /** Freeze this many leading columns (first block of the sheet only). */
  freezeCols?: number;
  /** Single-block sheets get a filter on the data rows unless told not to —
   *  a grid with interleaved subtotal rows must not be sortable. */
  autoFilter?: boolean;
}
export interface Sheet {
  name: string;
  blocks: Block[];
  landscape?: boolean;
}

const FMTS: Fmt[] = ['text', 'int', 'dec', 'dec1', 'pct', 'pct0', 'dur', 'datetime', 'date'];
const STYLES: Style[] = ['plain', 'cell', 'input', 'calc', 'bold', 'total', 'avg', 'delay', 'header', 'grand'];
const NUM_FMT: Record<Fmt, number> = { text: 0, int: 164, dec: 168, dec1: 170, pct: 165, pct0: 171, dur: 166, datetime: 167, date: 169 };
// cellXfs layout: 0 default, 1 title, 2 note, then STYLES × FMTS.
const XF_TITLE = 1, XF_NOTE = 2, XF_BASE = 3;
const xfOf = (style: Style, fmt: Fmt): number => XF_BASE + STYLES.indexOf(style) * FMTS.length + FMTS.indexOf(fmt);
const isTotal = (s?: Style): boolean => s === 'total' || s === 'grand';
const DAY_MS = 86_400_000;
const EXCEL_EPOCH_DAYS = 25_569;   // 1970-01-01 as an Excel serial

// Characters XML cannot carry (control characters other than tab/newline).
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + '-' + String.fromCharCode(31) + ']', 'g');
const esc = (s: string): string => s
  .replace(CONTROL, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A1-style column letters for a 0-based index. */
export function colLetters(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel serial for an instant, shown on the plant clock (tz = minutes east of UTC). */
export const excelDate = (d: Date | string | number, tzMin: number): number | null => {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? (t + tzMin * 60_000) / DAY_MS + EXCEL_EPOCH_DAYS : null;
};

/** A calendar date as a date cell whose serial is a whole number on the
 *  plant clock — so =A5=DATE(2026,9,1) is TRUE and pivots group by day. */
export const dateCell = (y: number, m: number, d: number, tzMin: number): Cell =>
  ({ v: new Date(Date.UTC(y, m - 1, d) - tzMin * 60_000), fmt: 'date' });

/** Where a block's first data row lands when it is the FIRST block on its
 *  sheet: title, note, bands, header, then data. The writer's contract, for
 *  callers that write subtotal formulas with real row numbers. */
export const firstDataRow = (b: Pick<Block, 'title' | 'note' | 'bands'>): number =>
  1 + (b.title ? 1 : 0) + (b.note ? 1 : 0) + (b.bands?.length ? 1 : 0) + 1;

interface Ctx { row: number; first: number; last: number; col: (key: string) => string }
const resolveFormula = (f: string, ctx: Ctx): string => f
  .replace(/\{col:([^}]+)\}/g, (_, k: string) => ctx.col(k))
  .replace(/\{row\}/g, String(ctx.row)).replace(/\{first\}/g, String(ctx.first)).replace(/\{last\}/g, String(ctx.last));

function cellXml(ref: string, cell: Cell, colFmt: Fmt | undefined, defStyle: Style, tzMin: number, ctx: Ctx): string {
  let v: Scalar; let f: string | undefined; let fmt: Fmt | undefined = colFmt; let style = defStyle;
  if (cell !== null && typeof cell === 'object' && !(cell instanceof Date)) { v = cell.v; f = cell.f; if (cell.fmt) fmt = cell.fmt; if (cell.style) style = cell.style; }
  else v = cell;
  const isDate = fmt === 'datetime' || fmt === 'date' || v instanceof Date;
  const xf = xfOf(style, fmt || (isDate ? 'datetime' : 'text'));
  if (f) {
    const ff = esc(resolveFormula(f, ctx));
    const cached = typeof v === 'number' && Number.isFinite(v) ? `<v>${fmt === 'dur' ? v / DAY_MS : v}</v>`
      : typeof v === 'string' && v !== '' ? `<v>${esc(v)}</v>` : '';
    return `<c r="${ref}" s="${xf}"${typeof v === 'string' && v !== '' ? ' t="str"' : ''}><f>${ff}</f>${cached}</c>`;
  }
  // A blank keeps its border and fill: a table with holes in it is not a
  // table, and the plant's TOTAL rows are shaded end to end.
  if (v == null || v === '') return style === 'plain' ? '' : `<c r="${ref}" s="${xf}"/>`;
  if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
  if (isDate) {
    const n = excelDate(v as Date | string | number, tzMin);
    return n == null ? `<c r="${ref}" s="${xf}"/>` : `<c r="${ref}" s="${xf}"><v>${n}</v></c>`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return `<c r="${ref}" s="${xf}"/>`;
    return `<c r="${ref}" s="${xf}"><v>${fmt === 'dur' ? v / DAY_MS : v}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr" s="${xf}"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(sheet: Sheet, tzMin: number): { xml: string; printTitleRows: number } {
  const rows: string[] = [];
  const merges: string[] = [];
  let r = 0;
  const widths: number[] = [];
  let freezeRow = 0; let freezeCol = 0; let filter = '';
  let printTitleRows = 0;
  const single = sheet.blocks.length === 1;
  for (const [bi, b] of sheet.blocks.entries()) {
    if (bi > 0) r += 1;   // a blank row between tables
    const nCols = b.columns.length;
    const lastCol = colLetters(Math.max(0, nCols - 1));
    b.columns.forEach((c, i) => {
      const hdr = typeof c.header === 'string' ? c.header : '';
      widths[i] = Math.max(widths[i] || 0, c.width || Math.min(40, Math.max(8, hdr.length + 2)));
    });
    if (b.title) {
      r += 1;
      rows.push(`<row r="${r}" ht="21" customHeight="1"><c r="A${r}" t="inlineStr" s="${XF_TITLE}"><is><t xml:space="preserve">${esc(b.title)}</t></is></c></row>`);
      if (nCols > 1) merges.push(`A${r}:${lastCol}${r}`);
    }
    if (b.note) {
      r += 1;
      // A merged cell never spills into its neighbours, so the note wraps and
      // the row grows to fit — roughly one line per (total width) characters.
      const chars = Math.max(40, b.columns.reduce((n, _, i) => n + (widths[i] || 10), 0));
      const lines = Math.max(1, Math.ceil(b.note.length / chars));
      rows.push(`<row r="${r}" ht="${Math.min(120, 14 * lines + 2)}" customHeight="1"><c r="A${r}" t="inlineStr" s="${XF_NOTE}"><is><t xml:space="preserve">${esc(b.note)}</t></is></c></row>`);
      if (nCols > 1) merges.push(`A${r}:${lastCol}${r}`);
    }
    if (b.bands?.length && nCols) {
      r += 1;
      let c = 0; const cells: string[] = [];
      for (const band of b.bands) {
        const span = Math.max(1, band.span);
        if (c + span > nCols) throw new Error(`xlsx: sheet ${sheet.name}: bands span ${c + span} columns, the block has ${nCols}`);
        cells.push(`<c r="${colLetters(c)}${r}" t="inlineStr" s="${xfOf(band.style || 'header', 'text')}"><is><t xml:space="preserve">${esc(band.label)}</t></is></c>`);
        // Bordered blanks so the merged band keeps its outline.
        for (let k = 1; k < span; k++) cells.push(`<c r="${colLetters(c + k)}${r}" s="${xfOf(band.style || 'header', 'text')}"/>`);
        if (span > 1) merges.push(`${colLetters(c)}${r}:${colLetters(c + span - 1)}${r}`);
        c += span;
      }
      for (; c < nCols; c++) cells.push(`<c r="${colLetters(c)}${r}" s="${xfOf('header', 'text')}"/>`);   // a short band list is padded
      rows.push(`<row r="${r}">${cells.join('')}</row>`);
    }
    if (!nCols) { if (bi === 0) printTitleRows = r; continue; }   // note-only block
    r += 1;
    const headerRow = r;
    if (bi === 0) printTitleRows = r;
    const col = (k: string): string => {
      const i = b.columns.findIndex((c) => c.key === k);
      if (i < 0) throw new Error(`xlsx: sheet ${sheet.name}: a formula refers to unknown column key "${k}"`);
      return colLetters(i);
    };
    const ctxHeader: Ctx = { row: r, first: r + 1, last: r + b.rows.length, col };
    rows.push(`<row r="${r}">${b.columns.map((c, i) => {
      const h = typeof c.header === 'string' ? { v: c.header, style: 'header' as Style } : { style: 'header' as Style, ...(c.header as object) };
      return cellXml(`${colLetters(i)}${r}`, h, undefined, 'header', tzMin, ctxHeader);
    }).join('')}</row>`);
    // {first}/{last} span the DATA rows: a TOTAL row summing {first}:{last}
    // must not include itself (Excel would flag the circular reference).
    const first = r + 1;
    const lastDataIdx = b.rows.reduce((n, row, i) => (isTotal(row.__style) ? n : i), -1);
    const last = lastDataIdx < 0 ? first : r + 1 + lastDataIdx;
    for (const row of b.rows) {
      r += 1;
      const ctx: Ctx = { row: r, first, last, col };
      const rowStyle = row.__style;
      const cells = b.columns.map((c, i) => cellXml(`${colLetters(i)}${r}`, row[c.key], c.fmt, rowStyle || c.style || 'cell', tzMin, ctx)).join('');
      rows.push(`<row r="${r}">${cells}</row>`);
    }
    if (bi === 0) {
      freezeRow = headerRow; freezeCol = Math.max(0, Math.min(nCols - 1, b.freezeCols || 0));
      // The filter covers the data rows only — sorting must never drag a
      // TOTAL row into the data.
      if (single && b.rows.length && b.autoFilter !== false) filter = `A${headerRow}:${lastCol}${last}`;
    }
  }
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const active = freezeRow && freezeCol ? 'bottomRight' : freezeRow ? 'bottomLeft' : 'topRight';
  const pane = freezeRow || freezeCol
    ? `<pane ${freezeCol ? `xSplit="${freezeCol}" ` : ''}${freezeRow ? `ySplit="${freezeRow}" ` : ''}topLeftCell="${colLetters(freezeCol)}${freezeRow + 1}" activePane="${active}" state="frozen"/><selection pane="${active}"/>`
    : '';
  const view = `<sheetViews><sheetView workbookViewId="0"${sheet.landscape ? ' zoomScale="90"' : ''}>${pane}</sheetView></sheetViews>`;
  const pageSetup = sheet.landscape
    ? '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    : '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet.landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}${view}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows.join('')}</sheetData>${filter ? `<autoFilter ref="${filter}"/>` : ''}${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}${pageSetup}</worksheet>`;
  return { xml, printTitleRows };
}

// ── styles.xml ───────────────────────────────────────────────────────────────
// fonts: 0 normal · 1 bold · 2 title · 3 note
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',                                                       // 0 none
  '<fill><patternFill patternType="gray125"/></fill>',                                                    // 1 (required by the spec)
  '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>',   // 2 header
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFCC"/><bgColor indexed="64"/></patternFill></fill>',   // 3 input yellow
  '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>',   // 4 avg green
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill>',   // 5 total grey
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>',   // 6 delay red
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>',   // 7 grand yellow
];
const NUM_FMTS = [
  '<numFmt numFmtId="164" formatCode="#,##0"/>', '<numFmt numFmtId="165" formatCode="0.0%"/>', '<numFmt numFmtId="166" formatCode="[h]:mm"/>',
  '<numFmt numFmtId="167" formatCode="dd-mmm-yyyy hh:mm"/>', '<numFmt numFmtId="168" formatCode="#,##0.0"/>', '<numFmt numFmtId="169" formatCode="d-mmm"/>',
  '<numFmt numFmtId="170" formatCode="0.0"/>', '<numFmt numFmtId="171" formatCode="0%"/>',
];
const STYLE_DEF: Record<Style, { font: number; fill: number; border: number; align?: string }> = {
  plain: { font: 0, fill: 0, border: 0 },
  cell: { font: 0, fill: 0, border: 1 },
  input: { font: 0, fill: 3, border: 1 },
  calc: { font: 0, fill: 0, border: 1 },
  bold: { font: 1, fill: 0, border: 1 },
  total: { font: 1, fill: 5, border: 1 },
  avg: { font: 1, fill: 4, border: 1 },
  delay: { font: 0, fill: 6, border: 1 },
  header: { font: 1, fill: 2, border: 1, align: '<alignment horizontal="center" vertical="center" wrapText="1"/>' },
  grand: { font: 1, fill: 7, border: 1 },
};
function stylesXml(): string {
  const xfs: string[] = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>',
  ];
  for (const st of STYLES) {
    const d = STYLE_DEF[st];
    for (const fmt of FMTS) {
      xfs.push(`<xf numFmtId="${NUM_FMT[fmt]}" fontId="${d.font}" fillId="${d.fill}" borderId="${d.border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${d.align ? ' applyAlignment="1"' : ''}>${d.align || ''}</xf>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${NUM_FMTS.length}">${NUM_FMTS.join('')}</numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font></fonts>
<fills count="${FILLS.length}">${FILLS.join('')}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9E9E9E"/></left><right style="thin"><color rgb="FF9E9E9E"/></right><top style="thin"><color rgb="FF9E9E9E"/></top><bottom style="thin"><color rgb="FF9E9E9E"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

const safeName = (n: string, i: number): string => (n.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`);

/** Every part of the package, in order. */
function parts(sheets: Sheet[], tzMin: number): { name: string; data: Buffer }[] {
  const names = sheets.map((s, i) => safeName(s.name, i));
  const xml = (s: string): Buffer => Buffer.from(s, 'utf8');
  const built = sheets.map((s) => sheetXml(s, tzMin));
  // A wide grid prints over several pages; repeating the title + header rows
  // on each is what makes page 3 of the month readable.
  const printTitles = built
    .map((b, i) => (sheets[i].landscape && b.printTitleRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${esc(names[i]).replace(/'/g, "''")}'!$1:$${b.printTitleRows}</definedName>` : ''))
    .join('');
  return [
    { name: '[Content_Types].xml', data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`) },
    // Naming the application lets LibreOffice apply its "recalculate Excel
    // files on load" rule; formulas also carry cached values where the
    // caller had the number.
    { name: 'docProps/app.xml', data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><AppVersion>16.0300</AppVersion></Properties>`) },
    // calcPr fullCalcOnLoad: formulas we wrote without cached values get computed the moment the file opens.
    { name: 'xl/workbook.xml', data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${printTitles ? `<definedNames>${printTitles}</definedNames>` : ''}<calcPr fullCalcOnLoad="1"/></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: xml(stylesXml()) },
    ...built.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml(b.xml) })),
  ];
}

// ── ZIP container ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A ZIP archive of the given entries — deflated, one local header + central
 *  directory, exactly what an .xlsx reader expects. */
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const locals: Buffer[] = []; const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const packed = deflateRawSync(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(e.data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(e.data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    centrals.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The workbook, ready to send. tzMin: the plant clock's offset from UTC in
 *  minutes (+330 for IST) — every date cell is shown on that clock. */
export function buildXlsx(sheets: Sheet[], tzMin = 330): Buffer {
  if (!sheets.length) throw new Error('a workbook needs at least one sheet');
  return zip(parts(sheets, tzMin));
}
