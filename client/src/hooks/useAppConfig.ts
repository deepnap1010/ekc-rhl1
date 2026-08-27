// client/src/hooks/useAppConfig.ts
// Shared config (server-side, same for all desktops): shifts, product catalog,
// process stages. Falls back to the local Settings seeds while loading or
// offline, so every consumer always has a usable list.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { configApi } from '../api/endpoints';
import { useSettings, patchSettings, type ShiftTiming } from '../lib/settings';

export interface AppConfigLists {
  shifts: ShiftTiming[];
  breaks: { name: string; start: string; end: string }[];
  stageTemplates: { name: string; defaultSec: number }[];
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
  // Shifts are SERVER-owned (app_config), and the Settings page edits the LOCAL
  // copy then pushes the whole array back. Without mirroring the server value
  // into localStorage, a device that still holds old timings shows them in
  // Settings and silently clobbers the admin's server-side shifts the moment
  // anyone touches a field there. Only shifts: products/processStages have
  // nothing stored server-side yet, so mirroring those would overwrite a
  // device's list with the seed.
  const serverShifts = data?.shifts?.length ? JSON.stringify(data.shifts) : '';
  const localShifts = JSON.stringify(s.shifts);
  useEffect(() => {
    if (serverShifts && serverShifts !== localShifts) {
      patchSettings((d) => { d.shifts = JSON.parse(serverShifts) as ShiftTiming[]; });
    }
  }, [serverShifts, localShifts]);

  return {
    shifts: data?.shifts?.length ? data.shifts : s.shifts,
    breaks: data?.breaks || [],
    stageTemplates: data?.stageTemplates || [],
    products: data?.products?.length ? data.products : s.production.products,
    processStages: data?.processStages?.length ? data.processStages : s.production.processStages,
    fromServer: !!data,
  };
}
