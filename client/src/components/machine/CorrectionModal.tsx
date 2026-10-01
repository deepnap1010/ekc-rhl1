// client/src/components/machine/CorrectionModal.tsx
// A machine card's door into the error-correction book: the machine and the
// card's window come fixed; everything else is CorrectionBook, the same
// screen Settings → Error correction shows for every machine.
import { Wrench } from 'lucide-react';
import Modal from '../Modal';
import CorrectionBook from './CorrectionBook';

export default function CorrectionModal({ code, name, from, to, onClose }: {
  code: string; name: string;
  from: string; to: string;    // the window the card was showing — the default period
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal title={`Correct ${name}`} subtitle="What this machine really did — the recorded data stays, the correction is written beside it" icon={Wrench} onClose={onClose} maxW="max-w-2xl">
      <CorrectionBook machine={{ code, name }} from={from} to={to} onRecorded={onClose} />
    </Modal>
  );
}
