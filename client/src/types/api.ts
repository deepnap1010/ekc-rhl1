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

// The range endpoints answer with the window they actually reconstructed (the
// server clips `to` to now), so a caller can divide by the SAME window the rows
// came from instead of re-deriving one that may not match yet.
export interface ActivityMeta {
  from: string;
  to: string;
  windowMs: number;
}

export interface ApiResponse<T, M = ApiMeta> {
  success: boolean;
  data: T;
  meta?: M;
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
  avatar?: string | null;
  active?: boolean;
  lastLoginAt?: string | null;
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
  avatar?: string;
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

// One row of GET /machines/activity?from&to — a machine's reconstructed state
// over a historical time range (derived read-only from telemetry + downtime).
export interface MachineActivityRow {
  code: string;
  name: string;
  type: string | null;
  status: string;      // dominant state during the range: running | idle | stopped | offline
  live: boolean;       // machine actually sent telemetry in the range
  readings: number;
  firstSeen: string | null;
  lastSeen: string | null;
  runningMs: number;
  idleMs: number;
  stoppedMs: number;
  offlineMs: number;
  production: number | null;      // production counter delta over the range
  productionKey: string | null;   // which signal the delta was read from
  productionFrom: string | null;  // set when an UPSTREAM machine counted it
  productionLagMs: number;        // how far behind that count runs here
  avgTemp: number | null;         // mean MEASURED temperature over the range (furnaces)
  tempZones: number;              // work zones that mean was taken over (0 = no temp signal)
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
// Shared (server-side) config — same shifts/products/stages on every desktop.
export interface AppConfigShape {
  shifts: { name: string; start: string; end: string }[];
  breaks?: BreakWindow[];   // planned daily pauses — targets exclude them
  stageTemplates?: StageTemplate[];   // plant-wide stage flow (names + default times)
  products: string[];
  processStages: string[];
  stored: boolean;
  // True when this deployment only MIRRORS the plant: it is refreshed from the
  // factory server, so changes made here would be overwritten.
  readOnly?: boolean;
}

// Range KPIs reconstructed for the dashboard's selected window (real figures
// from telemetry + downtime spans; oee stays null — inputs don't exist).
export interface DashboardWindow {
  from: string; to: string; windowMs: number;
  machines: number; reported: number;
  production: number;
  runningMs: number; idleMs: number; stoppedMs: number; offlineMs: number; downtimeMs: number;
  availabilityPct: number;
  oee: number | null;
}

// One machine's performance row over a range (dashboard rankings).
export interface RankingRow {
  code: string; name: string; type: string | null; status: string; live: boolean;
  production: number | null;
  runningMs: number; downtimeMs: number; idleMs: number;
  availabilityPct: number;
}

// Operational event (machine_events) — state sessions + production events.
export interface MachineEventRow {
  _id: string;
  machineId: string;
  kind: 'state' | 'production';
  state?: 'running' | 'idle' | 'stopped' | 'offline';
  prevState?: string | null;
  paramKey?: string;
  prevValue?: number;
  newValue?: number;
  delta?: number;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

// Minute-level change log row (machine History tab) — only real changes survive.
export interface TimelineRow {
  ts: string;
  production: number | null;  // the machine's raw counter at that minute
  made: number;               // pieces confirmed IN that minute
  total: number;              // pieces confirmed in the window so far — ends on the card's number
  status: string | null;
}

export interface EventsSummary {
  from: string; to: string;
  sessions: { running: number; idle: number; stopped: number; offline: number };
  durations: { runningMs: number; idleMs: number; stoppedMs: number; offlineMs: number };
  production: { events: number; pieces: number };
  totalEvents: number;
}

export interface DashboardOverview {
  filters?: { machineId: string | null; from: string | null; to: string | null };
  window?: DashboardWindow;
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
  from: string;
  to: string;
  totalOutput: number;
  reported: number;                 // machines that report a counter at all
  machines: {
    code: string;
    name: string;
    type: string | null;
    status: string;
    live: boolean;
    readings: number;
    output: number | null;          // null = this machine counts nothing
    productionKey: string | null;
    productionFrom: string | null;
    productionLagMs: number;
  }[];
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

// ─── Production targets (DIA) ─────────────────────────────────────────────
export interface DiaStage {
  key: string;
  name: string;
  seq: number;
  processingSec: number;   // per unit
  active: boolean;
}
export interface DiaConfig {
  _id: string;
  name: string;
  capacity: string;
  dims: string;
  active: boolean;
  retiredAt?: string | null;
  stages: DiaStage[];
  usedOn?: number;         // machines currently assigned to it
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: { id?: string; name?: string };
}
export interface AssignmentSnapshot {
  diaName: string;
  capacity: string;
  dims: string;
  stageName: string;
  processingSec: number;   // FROZEN at assignment time
}
export interface MachineAssignment {
  _id: string;
  machineRef: string;
  diaId: string;
  stageKey: string;
  snapshot: AssignmentSnapshot;
  effectiveFrom: string;
  effectiveTo: string | null;
  assignedBy?: { id?: string; name?: string };
  note?: string;
}

// One row of the targets report: (hour|day) × machine × assignment.
export interface TargetRow {
  bucket: string;          // ISO start of the hour / production day
  machineRef: string;
  dia: string;
  dims: string;
  stage: string;
  processingSec: number;
  assignedSec: number;
  downtimeSec: number;
  breakSec: number;        // planned daily breaks — excluded from BOTH targets
  actual: number;
  target: number;          // exact — display rounds
  targetAdj: number;       // downtime-adjusted target
  operator: string | null; // who was on the machine, when sessions are recorded
}
export interface TargetsDiaRollup {
  dia: string; dims: string; target: number; targetAdj: number; actual: number; downtimeSec: number; machines: number;
}
export interface TargetsMeta extends ApiMeta {
  groupBy: 'hour' | 'day';
  from: string; to: string; machines: number;
  byDia: TargetsDiaRollup[];
  totals: { target: number; targetAdj: number; actual: number; downtimeSec: number };
  operators: string[];     // everyone appearing in the window — feeds the filter
}
export interface ProductionOrder {
  _id: string;
  orderNo: string;
  diaId: string;
  diaName: string;
  quantity: number;
  status: 'open' | 'done' | 'cancelled';
  notes: string;
  startedAt: string;
  closedAt: string | null;
  produced: number;        // derived — counted pieces since the order opened
  createdBy?: { id?: string; name?: string };
  createdAt?: string;
}
export interface OperatorSession {
  _id: string;
  machineRef: string;
  userId: string;
  userName: string;
  startedAt: string;
  endedAt: string | null;
}
export interface BreakWindow { name: string; start: string; end: string }

// The plant's stage vocabulary in flow order — the TEMPLATE a new dia starts
// from. Each dia still carries its own per-stage time.
export interface StageTemplate { name: string; defaultSec: number }

export interface HourlyProduction {
  key: string | null;                    // which counter the bars came from
  hours: { t: string; made: number }[];  // ISO hour start (anchored to `from`) → pieces
}

// The name people call a machine. Server-side and shared, so one rename
// reaches every user on every device; the machine's real code never changes.
export interface MachineLabel {
  machineRef: string;      // the REAL code the PLC posts under
  displayName: string;
  updatedBy?: { id?: string; name?: string };
  updatedAt?: string;
}

// A dia assignment set for a FUTURE moment; the server applies it itself.
export interface ScheduledDia {
  _id: string;
  machineRef: string;
  diaId: string;
  diaName: string;
  stageKey: string;
  stageName: string;
  applyAt: string;
  status: 'pending' | 'applied' | 'cancelled' | 'failed';
  reason?: string;
  appliedAt?: string | null;
  createdBy?: { id?: string; name?: string };
  acks?: { userId: string; name?: string; at: string }[];
  createdAt: string;
}

// One run of a dia on a machine, with the pieces counted while it was live.
export interface DiaTraceRow {
  machineRef: string;
  dia: string;
  dims: string;
  stage: string;
  processingSec: number;
  from: string;
  to: string | null;        // null = running now
  produced: number | null;  // null = machine has no counter
  assignedBy: string;
  truncated: boolean;       // began before the 92-day counting window
}

export interface AuditRow {
  _id: string;
  at: string;
  user: { id?: string; name?: string };
  action: string;
  entity: { type: string; id?: string; label?: string };
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
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
