// client/src/api/endpoints.ts
import { api } from './client';
import type {
  ApiResponse,
  ApiMeta,
  ActivityMeta,
  LoginResponse,
  User,
  DashboardOverview,
  RankingRow,
  MachineEventRow,
  EventsSummary,
  AppConfigShape,
  ProductionByType,
  Machine,
  MachineSummary,
  MachineActivityRow,
  MachineStats,
  TimelineRow,
  Telemetry,
  DowntimeEvent,
  DowntimeSummary,
  AlertsResponse,
  ProductionReport,
  DowntimeReport,
  FleetReport,
  ReliabilityReport,
  OverviewReport,
  RbacMeta,
  Role,
  PermissionMatrix,
  OrgChartUser,
  UserWritePayload,
  DiaConfig,
  MachineAssignment,
  TargetRow,
  TargetsMeta,
  AuditRow,
  ProductionOrder,
  OperatorSession,
  BreakWindow,
  HourlyProduction,
} from '../types/api';

// The response interceptor unwraps to the `{ success, data, meta }` envelope, so
// every call resolves to `ApiResponse<T>` (axios's AxiosResponse type no longer
// applies at the call site). These thin generic helpers re-assert that contract
// without changing any runtime behavior.
type Params = Record<string, unknown>;

const get = <T, M = ApiMeta>(url: string, params?: Params): Promise<ApiResponse<T, M>> =>
  api.get(url, { params }) as unknown as Promise<ApiResponse<T, M>>;
const post = <T>(url: string, body?: unknown): Promise<ApiResponse<T>> =>
  api.post(url, body) as unknown as Promise<ApiResponse<T>>;
const patch = <T>(url: string, body?: unknown): Promise<ApiResponse<T>> =>
  api.patch(url, body) as unknown as Promise<ApiResponse<T>>;
const del = <T>(url: string): Promise<ApiResponse<T>> =>
  api.delete(url) as unknown as Promise<ApiResponse<T>>;

export const authApi = {
  login: (email: string, password: string) =>
    post<LoginResponse>('/auth/login', { email, password }),
  me: () => get<User>('/auth/me'),
  // Update the signed-in user's own name / email / avatar (persists to the DB).
  updateMe: (body: { name?: string; email?: string; avatar?: string }) => patch<User>('/auth/me', body),
};

export const dashboardApi = {
  overview: (params?: { machineId?: string; from?: string; to?: string }) =>
    get<DashboardOverview>('/dashboard/overview', params),
  production: () => get<ProductionByType[]>('/dashboard/production'),
  rankings: (params?: { from?: string; to?: string }) => get<RankingRow[]>('/dashboard/rankings', params),
};

export const eventsApi = {
  list: (params?: Params) => get<MachineEventRow[]>('/events', params),
  summary: (params?: Params) => get<EventsSummary>('/events/summary', params),
};

export const configApi = {
  get: () => get<AppConfigShape>('/config'),
  update: (body: Partial<Pick<AppConfigShape, 'shifts' | 'products' | 'processStages' | 'stageTemplates'>>) =>
    api.put('/config', body) as unknown as Promise<ApiResponse<AppConfigShape>>,
};

export const machineApi = {
  list: (params?: Params) => get<Machine[]>('/machines', params),
  summary: () => get<MachineSummary>('/machines/summary'),
  activity: (params: { from: string; to: string }) => get<MachineActivityRow[], ActivityMeta>('/machines/activity', params),
  get: (code: string) => get<Machine>(`/machines/${code}`),
  stats: (code: string, params?: Params) => get<MachineStats>(`/machines/${code}/stats`, params),
  // Mean of ONE signal over a window — the caller says which; the server never guesses.
  metricAverage: (code: string, params: { from: string; to: string; key: string }) =>
    get<{ key: string; avg: number | null; min: number | null; max: number | null; samples: number }>(`/machines/${code}/metric-average`, params),
  // Many machines, one round trip. `keys` is "CODE:key,CODE:key".
  metricAverages: (params: { from: string; to: string; keys: string }) =>
    get<{ code: string; key: string | null; avg: number; min: number; max: number; samples: number }[]>('/machines/metric-averages', params),
  history: (code: string, params?: Params) => get<Telemetry[]>(`/machines/${code}/history`, params),
  timeline: (code: string, params?: { from?: string; to?: string; page?: number; limit?: number }) => get<TimelineRow[]>(`/machines/${code}/timeline`, params),
  // Pieces made per hour over a window — the target board's bar chart.
  hourly: (code: string, params: { from: string; to: string }) => get<HourlyProduction>(`/machines/${code}/hourly`, params),
  downtime: (code: string, params?: Params) => get<DowntimeEvent[]>(`/machines/${code}/downtime`, params),
};

export const downtimeApi = {
  list: (params?: Params) => get<DowntimeEvent[]>('/downtime', params),
  summary: (params?: Params) => get<DowntimeSummary>('/downtime/summary', params),
  updateReason: (id: string, body: { reason: string; reportedBy?: string }) =>
    patch<DowntimeEvent>(`/downtime/${id}/reason`, body),
  acknowledge: (id: string, body: { acknowledged: boolean; acknowledgedBy?: string }) =>
    patch<DowntimeEvent>(`/downtime/${id}/ack`, body),
};

export const alertsApi = {
  list: (params?: Params) => get<AlertsResponse>('/alerts', params),
};

export const reportsApi = {
  overview: (params?: Params) => get<OverviewReport>('/reports/overview', params),
  production: (params?: Params) => get<ProductionReport>('/reports/production', params),
  downtime: (params?: Params) => get<DowntimeReport>('/reports/downtime', params),
  fleet: (params?: Params) => get<FleetReport>('/reports/fleet', params),
  reliability: (params?: Params) => get<ReliabilityReport>('/reports/reliability', params),
};

export interface DiaWritePayload {
  name?: string; capacity?: string; dims?: string;
  // seq is assigned server-side from list order; key omitted on new stages
  stages?: { key?: string; name: string; processingSec: number; active?: boolean }[];
}
export const productionApi = {
  dia: () => get<DiaConfig[]>('/production/dia'),
  createDia: (b: DiaWritePayload) => post<DiaConfig>('/production/dia', b),
  updateDia: (id: string, b: DiaWritePayload) => api.put(`/production/dia/${id}`, b) as unknown as Promise<ApiResponse<DiaConfig>>,
  setDiaActive: (id: string, active: boolean) => post<DiaConfig>(`/production/dia/${id}/active`, { active }),
  deleteDia: (id: string) => del<{ deleted: boolean }>(`/production/dia/${id}`),
  currentAssignments: () => get<MachineAssignment[]>('/production/assignments/current'),
  assignments: (params?: Params) => get<MachineAssignment[]>('/production/assignments', params),
  assign: (b: { machineRef: string; diaId: string; stageKey: string; note?: string }) =>
    post<MachineAssignment>('/production/assignments', b),
  unassign: (machineRef: string) => del<{ ended: boolean }>(`/production/assignments/current/${encodeURIComponent(machineRef)}`),
  targets: (params: Params) => get<TargetRow[], TargetsMeta>('/production/targets', params),
  audit: (params?: Params) => get<AuditRow[]>('/production/audit', params),
  setBreaks: (breaks: BreakWindow[]) => api.put('/production/breaks', { breaks }) as unknown as Promise<ApiResponse<{ breaks: BreakWindow[] }>>,
  orders: () => get<ProductionOrder[]>('/production/orders'),
  createOrder: (b: { orderNo: string; diaId: string; quantity: number; notes?: string }) => post<ProductionOrder>('/production/orders', b),
  updateOrder: (id: string, status: 'open' | 'done' | 'cancelled') => patch<ProductionOrder>(`/production/orders/${id}`, { status }),
  // Assign by dia NAME (the teammate build's shape) — the stage is matched from
  // the machine's family unless one is named. Same record as assign().
  setDiaByName: (code: string, dia: string, stage?: string) =>
    post<unknown>(`/machines/${encodeURIComponent(code)}/dia`, { dia, stage }),
  currentOperators: () => get<OperatorSession[]>('/production/operators/current'),
  setOperator: (b: { machineRef: string; userId: string }) => post<OperatorSession>('/production/operators', b),
  endOperator: (machineRef: string) => del<{ ended: boolean }>(`/production/operators/current/${encodeURIComponent(machineRef)}`),
};

export const rbacApi = {
  meta: () => get<RbacMeta>('/rbac/meta'),
  roles: () => get<Role[]>('/roles'),
  createRole: (body: Partial<Role>) => post<Role>('/roles', body),
  updatePermissions: (id: string, permissions: PermissionMatrix) =>
    patch<Role>(`/roles/${id}/permissions`, { permissions }),
  deleteRole: (id: string) => del<{ deleted: boolean }>(`/roles/${id}`),
};

export const userApi = {
  list: (params?: Params) => get<User[]>('/users', params),
  orgchart: () => get<OrgChartUser[]>('/users/orgchart'),
  create: (body: UserWritePayload) => post<User>('/users', body),
  update: (id: string, body: UserWritePayload) => patch<User>(`/users/${id}`, body),
  remove: (id: string) => del<{ deactivated: boolean }>(`/users/${id}`),
  deleted: (params?: Params) => get<User[]>('/users/deleted', params),
  deleteEmployee: (id: string, body: { type: string; reason?: string; from?: string; until?: string }) =>
    post<User>(`/users/${id}/delete`, body),
  restore: (id: string) => post<User>(`/users/${id}/restore`),
};
