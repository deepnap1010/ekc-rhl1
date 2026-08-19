// client/src/hooks/useAppConfig.ts
// Shared config (server-side, same for all desktops): shifts, product catalog,
// process stages. Falls back to the local Settings seeds while loading or
// offline, so every consumer always has a usable list.
import { useQuery } from '@tanstack/react-query';
import { configApi } from '../api/endpoints';
import { useSettings, type ShiftTiming } from '../lib/settings';

export interface AppConfigLists {
  shifts: ShiftTiming[];
  products: string[];
  processStages: string[];
  fromServer: boolean;
}

export function useAppConfig(): AppConfigLists {
  const s = useSettings();
  const { data } = useQuery({
    queryKey: ['app-config'],
    queryFn: () => configApi.get().then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  return {
    shifts: data?.shifts?.length ? data.shifts : s.shifts,
    products: data?.products?.length ? data.products : s.production.products,
    processStages: data?.processStages?.length ? data.processStages : s.production.processStages,
    fromServer: !!data,
  };
}
