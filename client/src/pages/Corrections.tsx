// client/src/pages/Corrections.tsx
// Error Correction — the book, for every machine this person can see: what a
// machine really did over a period when the collector started late or
// recorded it wrong. Written beside the recorded data, signed, revocable;
// every figure that overlaps the period (cards, reports, targets, the Excel
// review) reads the correction instead. A machine card's Correct button
// opens the same book for one machine.
//
// Reached only by roles holding the `corrections` module (the sidebar entry
// and the route both check it), which the admin grants on Roles & Permissions.
import { Wrench, Shield } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import CorrectionBook from '../components/machine/CorrectionBook';

export default function Corrections() {
  return (
    <div>
      <PageHeader title="Error Correction" subtitle="What a machine really did over a period — the recorded data stays, the correction is written beside it" />
      <div className="px-4 sm:px-6 pb-10 pt-5 space-y-5 max-w-5xl">
        <div className="panel p-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Wrench size={16} className="text-accent" /></span>
            <div className="min-w-0">
              <h2 className="font-semibold text-sm text-primary">Record a correction</h2>
              <p className="text-xs text-steel mt-0.5">The collector started at noon and the machine had been running since seven with 50 pieces made: pick the machine, the period, what it was doing and how many pieces it made. Counting continues from the telemetry after the period.</p>
            </div>
          </div>
          <CorrectionBook />
        </div>
        <div className="panel p-5">
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Shield size={16} className="text-accent" /></span>
            <div className="min-w-0">
              <h2 className="font-semibold text-sm text-primary">Who may correct</h2>
              <p className="text-xs text-steel mt-0.5">
                Roles &amp; Permissions → the <b>Corrections</b> module: <b>view</b> opens this page and reads the book, <b>create</b> records a correction, <b>delete</b> revokes one. Super admins have all three.
                A person corrects only the machines assigned to them (every machine when none are). Every correction and revocation goes to the audit log with who, when and why; a wrong correction is revoked, never deleted.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
