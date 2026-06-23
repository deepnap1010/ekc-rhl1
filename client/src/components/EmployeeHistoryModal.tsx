// client/src/components/EmployeeHistoryModal.tsx
// Employee History — every temporarily or permanently deleted employee. Temporary
// records show their suspension window and can be restored; permanent records are
// shown read-only.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Trash2, RotateCcw, Search, History } from 'lucide-react';
import Modal from './Modal';
import { Spinner } from './ui';
import { userApi } from '../api/endpoints';
import { fmtDate, fmtTime } from '../lib/format';
import type { User } from '../types/api';

export default function EmployeeHistoryModal({ onClose, canRestore }: { onClose: () => void; canRestore?: boolean }): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | temporary | permanent

  const { data, isLoading } = useQuery({
    queryKey: ['users', 'deleted', search, filter],
    queryFn: () => userApi.deleted({ search, ...(filter !== 'all' ? { type: filter } : {}) }).then((r) => r.data),
  });
  const rows = data || [];

  const restore = useMutation({
    mutationFn: (id: string) => userApi.restore(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['users', 'deleted'] });
    },
    onError: (e: unknown) => window.alert((e as { message?: string })?.message || 'Could not restore'),
  });

  const onRestore = (u: User) => { if (window.confirm(`Restore ${u.name} to the active roster?`)) restore.mutate(u.id); };

  return (
    <Modal title="Employee History" subtitle="Temporarily & permanently deleted employees" icon={History} onClose={onClose} maxW="max-w-3xl">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center gap-2 bg-base border border-line rounded-lg px-3 py-2 flex-1 min-w-[180px]">
          <Search size={14} className="text-steel" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email…" className="bg-transparent outline-none text-sm flex-1 text-primary placeholder:text-steel/60" />
        </div>
        {['all', 'temporary', 'permanent'].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-2 rounded-lg text-xs capitalize transition-colors ${filter === f ? 'bg-accent/10 text-accent font-medium' : 'text-steel hover:bg-base'}`}>{f}</button>
        ))}
      </div>

      {isLoading ? <Spinner label="Loading history" /> : rows.length === 0 ? (
        <div className="py-12 text-center text-steel text-sm">No deleted employees yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-base">
              <tr className="text-steel">
                <th className="text-left label px-3 py-2.5">Name</th>
                <th className="text-left label px-3 py-2.5">Type</th>
                <th className="text-left label px-3 py-2.5">Window</th>
                <th className="text-left label px-3 py-2.5">Deleted on</th>
                <th className="text-left label px-3 py-2.5">Reason</th>
                <th className="text-left label px-3 py-2.5">Removed by</th>
                {canRestore && <th className="text-right label px-3 py-2.5">Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const d = u.deletion;
                const isTemp = d?.type === 'temporary';
                return (
                  <tr key={u.id} className="border-t border-line">
                    <td className="px-3 py-3">
                      <div className="font-medium text-primary">{u.name}</div>
                      <div className="text-xs text-steel">{u.email}</div>
                      {(u.role?.name || u.isSuperAdmin) && <div className="text-[11px] text-steel/70">{u.isSuperAdmin ? 'Super Admin' : u.role?.name}{u.plant ? ` · ${u.plant}` : ''}</div>}
                    </td>
                    <td className="px-3 py-3">
                      {isTemp
                        ? <span className="pill bg-idle/10 text-idle inline-flex items-center gap-1"><Clock size={11} /> Temporary</span>
                        : <span className="pill bg-stopped/10 text-stopped inline-flex items-center gap-1"><Trash2 size={11} /> Permanent</span>}
                    </td>
                    <td className="px-3 py-3 text-steel text-xs">{isTemp ? `${fmtDate(d?.from)} → ${d?.until ? fmtDate(d.until) : 'indefinite'}` : '—'}</td>
                    <td className="px-3 py-3 text-steel text-xs">{fmtTime(d?.at)}</td>
                    <td className="px-3 py-3 text-steel text-xs max-w-[200px]">{d?.reason || '—'}</td>
                    <td className="px-3 py-3 text-steel text-xs">{u.removedBy || '—'}</td>
                    {canRestore && (
                      <td className="px-3 py-3 text-right">
                        {isTemp ? (
                          <button onClick={() => onRestore(u)} disabled={restore.isPending} className="inline-flex items-center gap-1 text-xs text-accent hover:bg-accent/10 border border-line hover:border-accent/40 rounded-lg px-2.5 py-1.5 disabled:opacity-60">
                            <RotateCcw size={12} /> Restore
                          </button>
                        ) : <span className="text-xs text-steel/60">—</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
