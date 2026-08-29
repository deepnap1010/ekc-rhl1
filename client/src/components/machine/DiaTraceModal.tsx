// client/src/components/machine/DiaTraceModal.tsx
// ONE machine's dia story, in place on its card: every dia it has run, newest
// first — dia badge, period, duration, pieces counted under it, % of rate.
// Same endpoint and row renderer as the full Dia Trace page, scoped by
// machineRef, so the card and the page can never tell different stories.
import { useQuery } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';
import Modal from '../Modal';
import { Spinner } from '../ui';
import { productionApi } from '../../api/endpoints';
import { fmtNum } from '../../lib/format';
import { TraceRun } from '../../pages/DiaTrace';

export default function DiaTraceModal({ code, onClose }: { code: string; onClose: () => void }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['dia-trace', code],
    queryFn: () => productionApi.trace({ machineRef: code }).then((r) => r.data),
  });
  const rows = data || [];
  const produced = rows.reduce((n, r) => n + (r.produced ?? 0), 0);
  const dias = new Set(rows.map((r) => r.dia)).size;

  return (
    <Modal title={`Dia trace · ${code.toUpperCase()}`}
      subtitle={rows.length ? `${rows.length} run${rows.length === 1 ? '' : 's'} · ${dias} dia${dias === 1 ? '' : 's'} · ${fmtNum(produced)} pcs counted` : 'Every dia this machine has run'}
      icon={Waypoints} onClose={onClose} maxW="max-w-lg">
      {isLoading ? <Spinner /> : !rows.length ? (
        <p className="text-sm text-steel">This machine has never been assigned a dia — its trail starts with the first assignment.</p>
      ) : (
        <div>
          {rows.map((r) => <TraceRun key={`${r.dia}-${r.from}`} r={r} showMachine={false} showDia />)}
        </div>
      )}
    </Modal>
  );
}
