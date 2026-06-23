// server/src/config/machineProfiles.ts
// Per-machine "profiles" — the human knowledge that turns raw PLC keys into a
// meaningful, machine-appropriate dashboard + anomaly rules:
//   • which keys are KEY PARAMETERS (label, set↔actual pairing for achievement %)
//   • expected / safe bands → out-of-band raises warning / critical alerts
//   • deviation %: allowed gap between a set value and its actual before warning
// Keyed by machineId (4 of 5 real machines report machineType "UNKNOWN", so
// machineId is the only reliable identity). A machine with no profile still
// renders via the generic classifier; it just has no curated key-parameter rules.

export const MACHINE_CLASS = {
  BOTTOM_MILLING: 'bottom_milling',
  FURNACE: 'furnace',
  QUENCH: 'quench',
} as const;

export interface RangeRule {
  min?: number;
  max?: number;
  criticalMin?: number;
  criticalMax?: number;
}

export interface KeyParam {
  label: string;
  set: string;
  actual?: string;
  actualLabel?: string;
  unit?: string;
  group?: string;
  deviation?: number;
  expected?: RangeRule;
}

export interface PatternRule {
  test: RegExp;
  unit?: string;
  rule: RangeRule;
}

export interface MachineProfile {
  class?: string;
  subtitle?: string;
  keyParams?: KeyParam[];
  patternRules?: PatternRule[];
}

export const PROFILES: Record<string, MachineProfile> = {
  ekc_bottom_milling_01: {
    class: MACHINE_CLASS.BOTTOM_MILLING,
    subtitle: 'Bottom Milling Machine',
    keyParams: [
      { label: 'Depth of Cutting', set: 'depth_of_cutting', actual: 'depth_actual', unit: 'raw', group: 'Depth Control', deviation: 5 },
      { label: 'Servo Slow', set: 'servo_slow', actual: 'servo_slow_actual', unit: 'raw', group: 'Servo Control', deviation: 5 },
      { label: 'Fast Servo', set: 'fast_servo', actual: 'dm130', actualLabel: 'DM130', unit: 'raw', group: 'Servo Control', deviation: 5 },
    ],
  },

  // Hardening + Tempering furnace. Zone-temp guard rails flag disconnected
  // thermocouples (sentinels) and impossible readings (e.g. negative °C).
  'ekc-furnace-s7300': {
    class: MACHINE_CLASS.FURNACE,
    subtitle: 'Hardening & Tempering Furnace',
    patternRules: [
      { test: /^[HT]_T\d+$/, unit: '°C', rule: { min: 50, max: 1000, criticalMin: 0 } },
    ],
  },
};

export const getProfile = (machineId: string): MachineProfile | null => PROFILES[machineId] || null;
