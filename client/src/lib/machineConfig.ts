// client/src/lib/machineConfig.ts
// Per-machine DISPLAY configuration — purely a presentation layer. It NEVER
// touches the machines / telemetries collections; everything is stored locally
// (localStorage) and applied client-side. So an operator can curate a machine's
// identity, work order / product, shift & personnel, and targets — without
// changing a single byte of the live PLC-sourced data.
//
// Grounded in EKC's business (everestkanto.com): seamless steel gas-cylinder
// manufacturing across the Tarapur, KASEZ, Dubai, Tianjin and Pittsburgh plants.
import { useEffect, useReducer } from 'react';

export const EKC_PLANTS = [
  'Tarapur', 'KASEZ (Gandhidham)', 'Dubai – Plant I', 'Dubai – Plant II', 'Tianjin (China)', 'Pittsburgh (USA)',
];
export const PROCESS_STAGES = [
  'Billet Heating', 'Bottom Forming / Milling', 'Heat Treatment (Hardening + Tempering)',
  'Quenching', 'Machining', 'Neck Forming / Threading', 'Hydrostatic Testing', 'Inspection & Marking', 'Other',
];
export const CYLINDER_PRODUCTS = [
  'CNG', 'Industrial Gas', 'Medical Oxygen', 'Fire Suppression', 'Hydrogen',
  'Breathing Air', 'Aluminium', 'Jumbo', 'Type-4 Composite',
];
export const SHIFTS = ['Shift A', 'Shift B', 'Shift C', 'General'];

export interface MachineTargets {
  capacity?: number;
  shiftTarget?: number;
  cycleTime?: number;
}

export interface MachineConfig {
  displayName?: string;
  line?: string;
  plant?: string;
  stage?: string;
  product?: string;
  spec?: string;
  workOrder?: string;
  batchNo?: string;
  shift?: string;
  supervisor?: string;
  operator?: string;
  targets?: MachineTargets;
  offlineMin?: number;
  updatedAt?: number;
}

type MachineLike = { machineId?: string; code?: string; id?: string; _id?: string };

// A stable per-machine key — the real docs use machineId as the business key.
export const machineKey = (m: MachineLike): string => m.machineId || m.code || m.id || m._id || '';

// ── localStorage store + tiny pub/sub so views re-render on save ───────────────
const STORE_KEY = 'ekc.machine.config.v1';
const listeners = new Set<() => void>();

type ConfigMap = Record<string, MachineConfig>;

function readStore(): ConfigMap {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as ConfigMap; }
  catch { return {}; }
}
function writeStore(map: ConfigMap): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(map));
  listeners.forEach((fn) => fn());
}

export function getConfig(id: string): MachineConfig {
  return readStore()[id] || {};
}
export function saveConfig(id: string, cfg: MachineConfig): void {
  const map = readStore();
  map[id] = { ...cfg, updatedAt: Date.now() };
  writeStore(map);
}
export function clearConfig(id: string): void {
  const map = readStore();
  delete map[id];
  writeStore(map);
}
export function configuredCount(): number {
  return Object.keys(readStore()).length;
}
export function isConfigured(id: string): boolean {
  const c = readStore()[id];
  return !!c && Object.keys(c).some((k) => k !== 'updatedAt');
}

// React hook — returns the live config for a machine, re-rendering on any save.
export function useMachineConfig(id: string): MachineConfig {
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);
  return getConfig(id);
}
