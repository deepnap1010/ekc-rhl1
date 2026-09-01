// client/src/components/ReviewCopyBanner.tsx
// Says, once and quietly, that this deployment is a copy.
//
// The cloud instance mirrors the factory server and is refreshed from it, so a
// change made here would be overwritten by the next sync. The API refuses those
// writes; this is so nobody tries in the first place and wonders why the button
// did nothing.
import { Eye } from 'lucide-react';
import { useAppConfig } from '../hooks/useAppConfig';

export default function ReviewCopyBanner(): JSX.Element | null {
  const { readOnly } = useAppConfig();
  if (!readOnly) return null;
  return (
    <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-idle/10 border-b border-idle/25 text-[12px] text-idle">
      <Eye size={13} className="shrink-0" />
      <span>
        <span className="font-semibold">Review copy.</span>{' '}
        A mirror of the plant for watching from outside — recent data, refreshed from the
        factory server. Changes are made on the plant dashboard.
      </span>
    </div>
  );
}
