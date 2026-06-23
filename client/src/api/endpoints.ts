// client/src/api/endpoints.ts
import { api } from './client';
import type {
  ApiResponse,
  LoginResponse,
  User,
  DashboardOverview,
  ProductionByType,
  Machine,
  MachineSummary,
  MachineStats,
  Telemetry,
  DowntimeEvent,
  DowntimeSummary,
  AlertsResponse,
  ProductionReport,
  DowntimeReport,
  PlantReport,
  FleetReport,
  ReliabilityReport,
  OverviewReport,
  RbacMeta,
  Role,
  PermissionMatrix,
  OrgChartUser,
  UserWritePayload,
} from '../types/api';

// The response interceptor unwraps to the `{ success, data, meta }` envelope, so
// every call resolves to `ApiResponse<T>` (axios's AxiosResponse type no longer
// applies at the call site). These thin generic helpers re-assert that contract
// without changing any runtime behavior.
type Params = Record<string, unknown>;

const get = <T>(url: string, params?: Params): Promise<ApiResponse<T>> =>
  api.get(url, { params }) as unknown as Promise<ApiResponse<T>>;
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
};

export const dashboardApi = {
  overview: () => get<DashboardOverview>('/dashboard/overview'),
  production: () => get<ProductionByType[]>('/dashboard/production'),
};

export const machineApi = {
  list: (params?: Params) => get<Machine[]>('/machines', params),
  summary: () => get<MachineSummary>('/machines/summary'),
  get: (code: string) => get<Machine>(`/machines/${code}`),
  stats: (code: string, params?: Params) => get<MachineStats>(`/machines/${code}/stats`, params),
  history: (code: string, params?: Params) => get<Telemetry[]>(`/machines/${code}/history`, params),
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
  plants: (params?: Params) => get<PlantReport[]>('/reports/plants', params),
  fleet: (params?: Params) => get<FleetReport>('/reports/fleet', params),
  reliability: (params?: Params) => get<ReliabilityReport>('/reports/reliability', params),
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
