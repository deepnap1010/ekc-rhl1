// client/src/pages/MachineDetail.tsx
import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  ArrowLeft, Download, FileText, Clock, History as HistoryIcon, Activity, SlidersHorizontal,
} from 'lucide-react';
import { machineApi, downtimeApi } from '../api/endpoints';
import { StatusPill, Spinner, FreshnessPill } from '../components/ui';
import TrendChart from '../components/TrendChart';
import ConfigurePanel from '../components/machine/ConfigurePanel';
import MachineOverview from '../components/machine/MachineOverview';
import { fmtNum, fmtMetric, fmtTime, fmtDuration, prettyKey, prettyType } from '../lib/format';
import { isFault, rankNamedKeys, flattenReading } from '../lib/metrics';
import { useMachineLive } from '../hooks/useLive';
import { useMachineConfig, machineKey } from '../lib/machineConfig';
import type { Machine, MetricValue } from '../types/api';

const TABS = [
  { key: 'overview',  label: 'Overview',  icon: Activity },
  { key: 'history',   label: 'History',   icon: HistoryIcon },
  { key: 'downtime',  label: 'Downtime',  icon: Clock },
  { key: 'specs',     label: 'Specs',     icon: FileText },
  { key: 'configure', label: 'Configure', icon: SlidersHorizontal },
];

export default function MachineDetail() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(TABS.some((t) => t.key === initialTab) ? (initialTab as string) : 'overview');

  const { data: machine, isLoading } = useQuery({
    queryKey: ['machine', code],
    queryFn: () => machineApi.get(code as string).then((r) => r.data),
    refetchInterval: 12000,
  });

  const live = useMachineLive(machine?.machineId || code);
  const cfg = useMachineConfig(machine ? machineKey(machine) : '');

  if (isLoading) return (
    <div className="flex items-center justify-center h-64"><Spinner label="Loading machine" /></div>
  );
  if (!machine) return (
    <div className="px-6 py-10 text-center text-steel">Machine not found: {code}</div>
  );

  const id = machine.machineId || machine.id || code;
  const status = live?.status || machine.status;
  const lastSeenAt = live?.lastReadingAt || machine.lastSeenAt || machine.lastReadingAt;
  const title = cfg.displayName || machine.name || id;
  const typeLabel = machine.type && machine.type !== 'UNKNOWN' ? prettyType(machine.type) : 'Unclassified';

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-line px-4 sm:px-6 py-4 shadow-sm">
        <div className="flex items-center gap-3 mb-1">
          <button onClick={() => navigate('/machines')} className="flex items-center gap-1.5 text-steel hover:text-primary text-sm transition-colors">
            <ArrowLeft size={16} /> Machines
          </button>
          <span className="text-line">/</span>
          <span className="data text-sm text-primary font-medium">{String(id).toUpperCase()}</span>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-primary truncate">{title}</h1>
            <p className="text-xs text-steel">
              {cfg.stage || typeLabel}{cfg.plant ? ` · ${cfg.plant}` : ''} · {fmtNum(machine.telemetryCount || 0)} readings
            </p>
          </div>
          <div className="flex items-center gap-3">
            <FreshnessPill lastSeenAt={lastSeenAt} />
            <StatusPill status={status} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-line bg-surface px-4 sm:px-6">
        <div className="flex gap-0 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm transition-colors whitespace-nowrap ${tab === t.key ? 'tab-active' : 'tab-inactive'}`}>
              <t.icon size={15} />{t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 sm:px-6 py-6">
        {tab === 'overview'  && <MachineOverview key={`ov-${id}`} machine={machine} status={status} lastSeenAt={lastSeenAt} onTab={setTab} />}
        {tab === 'history'   && <HistoryTab key={`hi-${id}`} code={id} />}
        {tab === 'downtime'  && <DowntimeTab key={`dt-${id}`} code={id} />}
        {tab === 'specs'     && <SpecsTab machine={machine} status={status} lastSeenAt={lastSeenAt} />}
        {tab === 'configure' && <ConfigurePanel key={`cf-${id}`} machine={machine} />}
      </div>
    </div>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;

function HistoryTab({ code }: { code?: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [cols, setCols] = useState<string[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['machine-history', code, from, to, page],
    queryFn: () => machineApi.history(code as string, { from: from || undefined, to: to || undefined, page, limit: PAGE_SIZE }),
    refetchInterval: 12000,
    placeholderData: keepPreviousData,
  });

  const total = data?.meta?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Flatten each raw reading so nested I/O (data.named.*) and raw PLC dumps
  // (data.active.*) surface as plottable columns. Registers stay excluded.
  const records = useMemo(
    () => (data?.data || []).map((r) => ({ ...r, data: flattenReading(r.data as Record<string, unknown>).named })),
    [data],
  );

  const available = useMemo(() => {
    const set = new Set<string>();
    records.forEach((r) => Object.keys(r.data).forEach((k) => set.add(k)));
    return rankNamedKeys(records, [...set]).slice(0, 60);
  }, [records]);

  useEffect(() => {
    if (cols === null && available.length) setCols(available.slice(0, 8));
  }, [available, cols]);
  const selected = cols || available.slice(0, 8);

  const toggleCol = (k: string) => setCols((prev) => {
    const cur = prev || available.slice(0, 8);
    return cur.includes(k) ? cur.filter((c) => c !== k) : [...cur, k];
  });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await machineApi.history(code as string, { from: from || undefined, to: to || undefined, page: 1, limit: 200 });
      const rows = (res?.data || []).map((r) => ({ ...r, data: flattenReading(r.data as Record<string, unknown>).named }));
      const header = ['Timestamp', ...selected.map(prettyKey)].join(',');
      const body = rows.map((r) => [
        new Date(r.timestamp).toISOString(),
        ...selected.map((k) => csvCell(r.data?.[k])),
      ].join(','));
      const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${code}_history.csv`; a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5 max-w-6xl">
      {/* Filters */}
      <div className="panel p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label block mb-1.5">From</label>
          <input type="datetime-local" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            className="bg-raised border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent text-primary" />
        </div>
        <div>
          <label className="label block mb-1.5">To</label>
          <input type="datetime-local" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }}
            className="bg-raised border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent text-primary" />
        </div>
        {(from || to) && (
          <button onClick={() => { setFrom(''); setTo(''); setPage(1); }} className="text-xs text-steel hover:text-primary px-2 py-2">Clear</button>
        )}
        <button onClick={exportCsv} disabled={exporting || !records.length}
          className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-2 rounded-lg hover:bg-accent/20 ml-auto disabled:opacity-50">
          <Download size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {/* Column picker */}
      {available.length > 0 && (
        <div className="panel p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="label mr-1">Columns:</span>
            {available.map((k) => {
              const on = selected.includes(k);
              return (
                <button key={k} onClick={() => toggleCol(k)}
                  className={`px-2.5 py-1 rounded-md text-[11px] border transition-colors ${on ? 'bg-accent/10 text-accent border-accent/30' : 'bg-base text-steel border-line hover:border-steel'}`}>
                  {prettyKey(k)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Multi-line metric trends */}
      <TrendChart code={code} from={from} to={to} keys={selected} />

      {/* Table */}
      {isLoading ? <Spinner /> : (
        <>
          <div className={`panel overflow-x-auto transition-opacity ${isFetching ? 'opacity-70' : ''}`}>
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-base border-b border-line">
                <tr>
                  <th className="text-left label px-4 py-3 sticky left-0 bg-base">Timestamp</th>
                  {selected.map((k) => <th key={k} className="text-right label px-4 py-3">{prettyKey(k)}</th>)}
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan={selected.length + 1} className="text-center text-steel py-10">No readings found{from || to ? ' in this range' : ''}</td></tr>
                ) : records.map((r) => (
                  <tr key={r._id} className="border-t border-line hover:bg-base/60">
                    <td className="px-4 py-2.5 data text-xs sticky left-0 bg-surface">{fmtTime(r.timestamp)}</td>
                    {selected.map((k) => {
                      const v = r.data?.[k];
                      const fault = isFault(v);
                      return <td key={k} className={`px-4 py-2.5 data text-xs text-right ${fault ? 'text-stopped font-medium' : ''}`}>{fault ? 'FAULT' : fmtMetric(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={page} pageCount={pageCount} total={total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function Pagination({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm flex-wrap gap-2">
      <span className="text-steel text-xs">{fmtNum(total)} reading{total === 1 ? '' : 's'} · page {page} of {pageCount}</span>
      <div className="flex gap-1.5">
        <PgBtn disabled={page === 1} onClick={() => onPage(1)}>« First</PgBtn>
        <PgBtn disabled={page === 1} onClick={() => onPage(page - 1)}>‹ Prev</PgBtn>
        <span className="px-3 py-1.5 text-steel data text-xs">{page} / {pageCount}</span>
        <PgBtn disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next ›</PgBtn>
        <PgBtn disabled={page >= pageCount} onClick={() => onPage(pageCount)}>Last »</PgBtn>
      </div>
    </div>
  );
}

function PgBtn({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick}
      className="px-3 py-1.5 rounded-lg bg-surface border border-line text-xs disabled:opacity-40 hover:bg-base hover:border-steel/40 transition-colors">
      {children}
    </button>
  );
}

// ─── Downtime ────────────────────────────────────────────────────────────────
function DowntimeTab({ code }: { code?: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['machine-downtime', code, page],
    queryFn: () => downtimeApi.list({ machineId: code, page, limit: 20 }),
    placeholderData: keepPreviousData,
  });
  const events = data?.data || [];
  const total = data?.meta?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / 20));

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-base border-b border-line">
            <tr>{['Type', 'Started', 'Ended', 'Duration', 'Reason'].map((h) => <th key={h} className="text-left label px-4 py-3">{h}</th>)}</tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr><td colSpan={5} className="text-center text-steel py-10">No downtime events recorded</td></tr>
            ) : events.map((e) => (
              <tr key={e._id} className="border-t border-line hover:bg-base/60">
                <td className="px-4 py-3">
                  <span className={`pill ${e.type === 'stopped' ? 'bg-stopped/10 text-stopped' : e.type === 'offline' ? 'bg-steel/10 text-steel' : 'bg-idle/10 text-idle'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${e.type === 'stopped' ? 'bg-stopped' : e.type === 'offline' ? 'bg-steel' : 'bg-idle'}`} />
                    {e.type}
                  </span>
                </td>
                <td className="px-4 py-3 data text-xs">{fmtTime(e.startedAt)}</td>
                <td className="px-4 py-3 data text-xs">{e.endedAt ? fmtTime(e.endedAt) : <span className="text-stopped font-medium text-[11px]">● Open</span>}</td>
                <td className="px-4 py-3 data text-xs text-idle">{e.durationMs ? fmtDuration(e.durationMs) : (e.endedAt ? '—' : 'Ongoing')}</td>
                <td className="px-4 py-3 text-xs text-steel">{e.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > 20 && <Pagination page={page} pageCount={pageCount} total={total} onPage={setPage} />}
    </div>
  );
}

// ─── Specs ───────────────────────────────────────────────────────────────────
function SpecsTab({ machine, status, lastSeenAt }: { machine: Machine; status?: string; lastSeenAt?: string | Date | null }) {
  const id = machine.machineId || machine.id;
  return (
    <div className="max-w-3xl space-y-5">
      <div className="panel p-6 space-y-4">
        <h2 className="font-semibold text-primary">Machine Specifications</h2>
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <InfoRow label="Machine ID" value={String(id || '—').toUpperCase()} mono />
          <InfoRow label="Name" value={machine.name || '—'} />
          <InfoRow label="Type" value={machine.type && machine.type !== 'UNKNOWN' ? prettyType(machine.type) : 'Unclassified'} />
          <InfoRow label="Status" value={<StatusPill status={status} />} />
          <InfoRow label="Active" value={machine.isActive ? 'Yes' : 'No'} />
          <InfoRow label="Freshness" value={<FreshnessPill lastSeenAt={lastSeenAt} />} />
          <InfoRow label="Registered" value={fmtTime(machine.registeredAt)} />
          <InfoRow label="Last reading" value={fmtTime(machine.latest?.ts || lastSeenAt)} />
          <InfoRow label="Readings logged" value={fmtNum(machine.telemetryCount || 0)} />
          <InfoRow label="Live metrics" value={fmtNum(machine.latest?.namedCount || 0)} />
          <InfoRow label="Raw registers" value={fmtNum(machine.registerCount || 0)} />
          <InfoRow label="Sensor faults" value={fmtNum(machine.latest?.faultCount || 0)} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-line last:border-0">
      <span className="text-steel text-xs shrink-0">{label}</span>
      <span className={`text-xs font-medium text-primary text-right ${mono ? 'data' : ''}`}>{value}</span>
    </div>
  );
}

function csvCell(v: MetricValue): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
