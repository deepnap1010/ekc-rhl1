// client/src/types/api.ts
// Shared API + domain types. These mirror the shapes the backend controllers
// return (see server/src/controllers/*). The wire envelope is unwrapped by the
// axios response interceptor, so callers receive `ApiResponse<T>` directly.

// ─── Envelope ──────────────────────────────────────────────────────────────
export interface ApiMeta {
  total: number;
  page: number;
  limit: number;
  pages?: number;
}

export interface ApiError {
  message: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: ApiMeta;
  error?: ApiError;
}

// A telemetry / live-parameter payload is schema-agnostic per machine type:
// numeric measurements plus the occasional string (e.g. "department").
export type MetricValue = number | string | null | undefined;
export type ParameterMap = Record<string, MetricValue>;
export type ThresholdMap = Record<string, MetricValue>;

// ─── RBAC ────────────────────────────────────────────────────────────────────
// module -> list of allowed actions, e.g. { dashboard: ['view'], machines: ['view','update'] }
export type PermissionMatrix = Record<string, string[]>;

export interface UserRole {
  id: string;
  name: string;
  key: string;
  // Only the authenticated user's own role (from /auth/login & /auth/me) carries
  // the permission matrix; the trimmed role on listed users omits it.
  permissions?: PermissionMatrix;
}

export interface User {
  id: string;
  name: string;
  email: string;
  plant?: string | null;
  isSuperAdmin?: boolean;
  role: UserRole | null;
  assignedMachines?: string[];
  reportsTo?: string | null;
  active?: boolean;
  deletion?: UserDeletion | null;
  // Present only on rows from GET /users/deleted (Employee History).
  removedBy?: string | null;
  joinedAt?: string | null;
  permanent?: boolean;
}

export interface UserDeletion {
  type: 'temporary' | 'permanent';
  reason?: string;
  at?: string | null;
  by?: string | null;
  from?: string | null;
  until?: string | null;
}

// What the client SENDS when creating/updating a user. `role` is the role _id
// (the server resolves it to the role document), so writes use this distinct
// payload shape rather than the read model where `role` is a UserRole object.
export interface UserWritePayload {
  name?: string;
  email?: string;
  password?: string;
  role?: string | null;
  plant?: string | null;
  reportsTo?: string | null;
  assignedMachines?: string[];
  isSuperAdmin?: boolean;
  active?: boolean;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
  bootstrap?: boolean;
}

export interface Role {
  _id: string;
  name: string;
  key: string;
  description?: string;
  isSystem?: boolean;
  permissions: PermissionMatrix;
  createdAt?: string;
  updatedAt?: string;
}

export interface RbacMeta {
  modules: string[];
  actions: string[];
}

// ─── Plant ─────────────────────────────────────────────────────────────────
export interface Plant {
  _id: string;
  name: string;
  code?: string;
  location?: string;
}

// ─── Machine ─────────────────────────────────────────────────────────────────
// `strict: false` on the server model lets arbitrary fields flow through, so a
// few legacy/alias keys (machineId, machineName, machineType) may also appear.
export interface MachineMetric { key: string; value: MetricValue; numeric: boolean; fault: boolean; }
export interface MachineIO { key: string; on: boolean; value?: MetricValue; }
export interface MachineRegister { key: string; value: MetricValue; }
export interface MachineLatestInfo { ts?: string | null; hasData?: boolean; namedCount?: number; registerCount?: number; ioCount?: number; faultCount?: number; }

export interface Machine {
  _id: string;
  name?: string;
  code?: string;
  type?: string;
  plant?: Plant | null;
  status?: string;

  currentParameters?: ParameterMap;
  thresholds?: ThresholdMap;
  latestData?: ParameterMap;
  liveParameters?: ParameterMap;
  metricKeys?: string[];

  ratedCapacity?: number;
  oee?: number;
  totalOutput?: number;
  lastReadingAt?: string | null;
  installedOn?: string | null;
  telemetryCount?: number;
  latestTelemetry?: Telemetry | null;

  // Rich MachineOverview contract (normalized real values from GET /machines/:code)
  id?: string;
  subtitle?: string | null;
  class?: string | null;
  isActive?: boolean;
  registeredAt?: string | null;
  lastSeenAt?: string | null;
  metrics?: MachineMetric[];
  inputs?: MachineIO[];
  outputs?: MachineIO[];
  registers?: MachineRegister[];
  registerCount?: number;
  ioCount?: number;
  latest?: MachineLatestInfo;

  // Legacy / alias fields tolerated by the read-only mirror.
  machineId?: string;
  machineName?: string;
  machineType?: string;

  createdAt?: string;
  updatedAt?: string;
}

export interface MetricStat {
  key: string;
  last: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  samples: number;
  faultCount: number;
  spark: number[];
}

export interface MachineStats {
  window: number;
  metricCount: number;
  metrics: MetricStat[];
}

export interface MachineSummary {
  total: number;
  running: number;
  idle: number;
  stopped: number;
  offline: number;
}

// ─── Telemetry ─────────────────────────────────────────────────────────────
export interface Telemetry {
  _id: string;
  machineId: string;
  timestamp: string;
  // Reading payload keys vary per machinetype; values are numbers or strings.
  data: ParameterMap;
}

// ─── Downtime ──────────────────────────────────────────────────────────────
export type DowntimeType = 'idle' | 'stopped' | 'offline';

export interface DowntimeEvent {
  _id: string;
  machineId: string;
  type: DowntimeType;
  startedAt: string;
  endedAt: string | null;
  durationMs?: number;
  reason?: string;
  reportedBy?: string;
  acknowledged?: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DowntimeMachineRollup {
  _id: string;
  events: number;
  totalMs: number;
}

export interface DowntimeTypeRollup { type: string; events: number; totalMs: number; }

export interface DowntimeSummary {
  totalEvents: number;
  totalMs: number;
  openEvents: number;
  idleEvents: number;
  stoppedEvents: number;
  unacknowledged: number;
  worstMachines: DowntimeMachineRollup[];
  byType: DowntimeTypeRollup[];
}

// ─── Alerts ──────────────────────────────────────────────────────────────────
export type AlertSeverity = 'fault' | 'critical' | 'warning' | 'info';

export interface Alert {
  machineId: string;
  machineName: string;
  class: string | null;
  type: string | null;
  machineStatus: string;
  lastSeenAt: string | null;
  ts: string | null;
  key: string;
  severity: AlertSeverity;
  value: number | string | null;
  message: string;
}

export interface AlertSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
  machinesAffected: number;
}

export interface AlertMachineHealth {
  machineId: string;
  name: string;
  class: string | null;
  status: string;
  health: string;
  score: number;
  alerts: number;
  lastSeenAt: string | null;
}

export interface AlertsResponse {
  alerts: Alert[];
  summary: AlertSummary;
  machines: AlertMachineHealth[];
}

// ─── Fleet & reliability reports ─────────────────────────────────────────────
export interface FleetReportMachine {
  machineId: string;
  name: string;
  type: string | null;
  class: string | null;
  status: string;
  health: string;
  score: number;
  readings: number;
  namedCount: number;
  ioCount: number;
  registers: number;
  faultCount: number;
  downtimeMs: number;
  downtimeEvents: number;
}
export interface FleetReportClass { class: string; machines: number; readings: number; faults: number; avgScore: number; }
export interface FleetReport {
  machines: FleetReportMachine[];
  byClass: FleetReportClass[];
  totals: { machines: number; readings: number; signals: number; registers: number; faults: number };
}

export interface ReliabilityMachine {
  machineId: string;
  events: number;
  downtimeMs: number;
  availability: number;
  mttrMs: number;
  mtbfMs: number;
}
export interface ReliabilityReport { windowDays: number; machines: ReliabilityMachine[]; }

// ─── Reports: Overview (live downtime & error analysis console) ──────────────
export interface OverviewKpis {
  machines: number;
  running: number; idle: number; stopped: number; offline: number;
  faults: number; errors: number;
  criticalMachines: number; warningMachines: number;
  avgHealth: number;
  downtimeMs: number; downtimeEvents: number; openDowntime: number;
}
export interface OverviewCount { key: string; label: string; count: number; }
export interface OverviewDowntimeMachine { machineId: string; events: number; totalMs: number; open: number; }
export interface OverviewReport {
  windowDays: number;
  kpis: OverviewKpis;
  statusMix: OverviewCount[];
  errorsByStatus: OverviewCount[];
  downtimeByMachine: OverviewDowntimeMachine[];
}

// ─── Dashboard ─────────────────────────────────────────────────────────────
export interface StatusCounts {
  total: number;
  running: number;
  idle: number;
  stopped: number;
  offline: number;
}

export interface PipelineEntry {
  type: string;
  count: number;
  running: number;
  output: number;
}

// Fleet ANALYSIS overview (GET /dashboard/overview) — aggregate insights, drill-downs.
export interface OvHealthCounts { critical: number; warning: number; total: number }
export interface OvMachineHealth { score: number; status: string; freshness: string; counts: OvHealthCounts; alerts: { key: string; severity: string; value: number | string | null; message: string; category: string }[] }
export interface OvMachine {
  machineId: string; name: string; type: string | null; class: string | null; status: string;
  lastSeenAt: string | null; readings: number; namedCount: number; ioCount: number; registers: number; faultCount: number;
  health: OvMachineHealth;
}
export interface OvCapabilityBlocked { name: string; needs: string }
export interface DashboardOverview {
  fleet: { total: number; running: number; idle: number; stopped: number; offline: number };
  health: { healthy: number; warning: number; critical: number; offline: number; avgScore: number };
  reporting: { reporting: number; live: number; total: number };
  alerts: { total: number; critical: number; warning: number; info: number; byCategory: Record<string, number> };
  signals: { named: number; io: number; registers: number; mapped: number; total: number; mappedPct: number };
  volume: { totalReadings: number; perDay: { day: string; readings: number }[]; byType: { type: string; count: number; readings: number }[] };
  downtime: { totalMs: number; events: number };
  composition: { byType: { type: string; count: number }[]; byClass: { class: string; count: number; alerts: number }[] };
  capabilities: { live: string[]; blocked: OvCapabilityBlocked[]; liveCount: number; total: number };
  machines: OvMachine[];
  employees: number;
  team: { employees: number; superAdmins: number; roles: number; byRole: { role: string; count: number }[] };
}

export interface ProductionByType {
  type: string;
  output: number;
  efficiency: number;
  machines: number;
  running: number;
}

// ─── Reports ───────────────────────────────────────────────────────────────
export interface ReportMachineRow {
  code: string;
  name?: string;
  type?: string;
  plant: string;
  status?: string;
  output: number;
  efficiency: number;
  capacity: number; 
}

export interface ReportByPlant {
  plant: string;
  output: number;
  efficiency: number;
  machines: number;
  running: number;
} 

export interface ProductionReport {
  byType: ProductionByType[];
  byPlant: ReportByPlant[];
  machines: ReportMachineRow[];
}

export interface DowntimeReportTotals {
  totalEvents: number;
  totalMs: number;
}

export interface DowntimeReportTypeRow {
  _id: string;
  events: number;
  totalMs: number;
}

export interface DowntimeReportMachineRow {
  _id: string;
  events: number;
  totalMs: number;
}

export interface DowntimeReport {
  totals: DowntimeReportTotals;
  byType: DowntimeReportTypeRow[];
  byMachine: DowntimeReportMachineRow[];
}

export interface PlantReport {
  plant: string;
  total: number;
  running: number;
  idle: number;
  stopped: number;
  offline: number;
  totalOutput: number;
  avgEfficiency: number;
}

// ─── Org chart ─────────────────────────────────────────────────────────────
export type OrgChartUser = User;

// ─── Live socket payloads ────────────────────────────────────────────────────
export interface MachineTick {
  machineId: string;
  status?: string;
  oee?: number;
  totalOutput?: number;
  currentParameters?: ParameterMap;
  lastReadingAt?: string | null;
}

export type TicksMap = Record<string, MachineTick>;

export type MachineUpdate = Machine;
