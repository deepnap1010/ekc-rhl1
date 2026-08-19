// client/src/pages/MachineDetail.tsx
import { useState, type ReactNode } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  ArrowLeft, FileText, Clock, History as HistoryIcon, Activity, SlidersHorizontal, Cpu,
} from 'lucide-react';
import { machineApi, downtimeApi } from '../api/endpoints';
import { StatusPill, Spinner, FreshnessPill } from '../components/ui';
import ConfigurePanel from '../components/machine/ConfigurePanel';
import MachineOverview from '../components/machine/MachineOverview';
import ParametersModal from '../components/machine/MachineParameters';
import MachineTimeline from '../components/machine/MachineTimeline';
import { fmtNum, fmtTime, fmtDuration, prettyType } from '../lib/format';
import { effectiveStatus } from '../lib/machineStatus';
import { useMachineLive } from '../hooks/useLive';
import { useMachineConfig, machineKey } from '../lib/machineConfig';
import type { Machine } from '../types/api';

const TABS = [
  { key: 'overview',  label: 'Overview',  icon: Activity },
  { key: 'history',   label: 'History',   icon: HistoryIcon }, // minute-level change log (production + status)
  { key: 'downtime',  label: 'Downtime',  icon: Clock },
  { key: 'specs',     label: 'Specs',     icon: FileText },
  { key: 'configure', label: 'Configure', icon: SlidersHorizontal },
];

export default function MachineDetail() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  // Parameters is a MODAL, not a tab — ?tab=parameters deep links (machine
  // cards) open it over the Overview; the retired raw-log tab maps to History.
  const [tab, setTab] = useState(
    TABS.some((t) => t.key === initialTab) ? (initialTab as string)
      : initialTab === 'telemetry' ? 'history'
      : 'overview'
  );
  const [paramsOpen, setParamsOpen] = useState(initialTab === 'parameters');

  const { data: machine, isLoading } = useQuery({
    queryKey: ['machine', code],
    queryFn: () => machineApi.get(code as string).then((r) => r.data),
    refetchInterval: 10000,
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
  const lastSeenAt = live?.lastReadingAt || machine.lastSeenAt || machine.lastReadingAt;
  // Same rule as the cards: 10+ min of silence shows Signal Lost, not a stale status.
  const status = effectiveStatus({
    status: live?.status || machine.status,
    lastReadingAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
  });
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

      {/* Tabs + the Parameters module trigger */}
      <div className="border-b border-line bg-surface px-4 sm:px-6">
        <div className="flex gap-0 overflow-x-auto items-center">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm transition-colors whitespace-nowrap ${tab === t.key ? 'tab-active' : 'tab-inactive'}`}>
              <t.icon size={15} />{t.label}
            </button>
          ))}
          <button onClick={() => setParamsOpen(true)}
            className="ml-auto my-1.5 shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent/20 bg-accent/5 text-accent text-sm font-medium hover:bg-accent/10 transition-colors whitespace-nowrap">
            <Cpu size={14} /> Parameters
          </button>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-6">
        {tab === 'overview'   && <MachineOverview key={`ov-${id}`} machine={machine} status={status} lastSeenAt={lastSeenAt} onTab={setTab} />}
        {tab === 'history'   && <MachineTimeline key={`tl-${id}`} machine={machine} code={String(id)} />}
        {tab === 'downtime'  && <DowntimeTab key={`dt-${id}`} code={id} />}
        {tab === 'specs'     && <SpecsTab machine={machine} status={status} lastSeenAt={lastSeenAt} />}
        {tab === 'configure' && <ConfigurePanel key={`cf-${id}`} machine={machine} />}
      </div>

      {paramsOpen && (
        <ParametersModal machine={machine} code={String(id)} onClose={() => setParamsOpen(false)} />
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
