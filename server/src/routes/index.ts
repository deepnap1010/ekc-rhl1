// server/src/routes/index.ts
import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import * as auth from '../controllers/auth.controller.js';
import * as ingest from '../controllers/ingest.controller.js';
import * as machine from '../controllers/machine.controller.js';
import * as dash from '../controllers/dashboard.controller.js';
import * as rbac from '../controllers/rbac.controller.js';
import * as downtime from '../controllers/downtime.controller.js';
import * as reports from '../controllers/reports.controller.js';
import * as alerts from '../controllers/alerts.controller.js';
import * as events from '../controllers/events.controller.js';
import * as config from '../controllers/config.controller.js';
import * as prod from '../controllers/production.controller.js';

const r = Router();

// --- Public ---
r.post('/auth/login', auth.login);
r.post('/ingest', ingest.ingest); // PLC / data-source telemetry ingest — guarded by the x-ingest-key header

// --- Everything below requires a valid session ---
r.use(authenticate);

r.get('/auth/me', auth.me);
r.patch('/auth/me', auth.updateMe); // self-service profile edit (name / email / avatar)

// Dashboard
r.get('/dashboard/overview', authorize('dashboard'), dash.overview);
r.get('/dashboard/production', authorize('dashboard'), dash.production);
r.get('/dashboard/rankings', authorize('dashboard'), dash.rankings); // per-machine performance over a range

// Machines (read-only) — identified by code
r.get('/machines', authorize('machines'), machine.listMachines);
r.get('/machines/summary', authorize('machines'), machine.machineSummary);
r.get('/machines/activity', authorize('machines'), machine.machineActivity); // historical range view (read-only)
r.get('/machines/metric-averages', authorize('machines'), machine.machineMetricAverages); // many machines, one round trip — MUST stay above /:code
r.get('/machines/:code', authorize('machines'), machine.getMachine);
r.get('/machines/:code/stats', authorize('machines'), machine.machineStats);
r.get('/machines/:code/series', authorize('history'), machine.machineSeries);
r.get('/machines/:code/metric-average', authorize('machines'), machine.machineMetricAverage); // mean of one signal over a window
r.get('/machines/:code/history', authorize('history'), machine.machineHistory);
r.get('/machines/:code/timeline', authorize('history'), machine.machineTimeline); // minute-level change log
r.get('/machines/:code/downtime', authorize('downtime'), downtime.machineDowntime);

// Shared config — shifts / products / process stages, same for every desktop
r.get('/config', config.getConfig);
r.put('/config', authorize('settings', 'update'), config.updateConfig);

// Operational events — state sessions + production events (read-only feed)
r.get('/events', authorize('history'), events.listEvents);
r.get('/events/summary', authorize('history'), events.eventsSummary);

// Downtime
r.get('/downtime', authorize('downtime'), downtime.listDowntime);
r.get('/downtime/summary', authorize('downtime'), downtime.downtimeSummary);
r.patch('/downtime/:id/reason', authorize('downtime', 'update'), downtime.updateReason);
r.patch('/downtime/:id/ack', authorize('downtime', 'update'), downtime.acknowledgeDowntime);

// Production targets - DIA products, stages, machine assignments (module: production)
r.get('/production/dia', authorize('production'), prod.listDia);
r.post('/production/dia', authorize('production', 'create'), prod.createDia);
r.put('/production/dia/:id', authorize('production', 'update'), prod.updateDia);
r.post('/production/dia/:id/active', authorize('production', 'delete'), prod.setDiaActive);
r.get('/production/assignments/current', authorize('production'), prod.currentAssignments);
r.get('/production/assignments', authorize('production'), prod.listAssignments);
r.post('/production/assignments', authorize('production', 'update'), prod.assignMachine);
r.delete('/production/assignments/current/:machineRef', authorize('production', 'update'), prod.unassignMachine);
r.get('/production/targets', authorize('production'), prod.targetsReport);
r.put('/production/breaks', authorize('production', 'update'), prod.setBreaks);
r.get('/production/orders', authorize('production'), prod.listOrders);
r.post('/production/orders', authorize('production', 'create'), prod.createOrder);
r.patch('/production/orders/:id', authorize('production', 'update'), prod.updateOrder);
r.get('/production/operators/current', authorize('production'), prod.currentOperators);
r.post('/production/operators', authorize('production', 'update'), prod.setOperator);
r.delete('/production/operators/current/:machineRef', authorize('production', 'update'), prod.endOperator);
r.get('/production/audit', authorize('production', 'admin'), prod.listAudit);

// Reports
r.get('/reports/overview', authorize('reports'), reports.overviewReport);
r.get('/reports/production', authorize('reports'), reports.productionReport);
r.get('/reports/downtime', authorize('reports'), reports.downtimeReport);
r.get('/reports/fleet', authorize('reports'), reports.fleetReport);
r.get('/reports/reliability', authorize('reports'), reports.reliabilityReport);

// Alerts — fleet-wide, derived live from the anomaly engine
r.get('/alerts', authorize('alerts'), alerts.listAlerts);

// RBAC — roles
r.get('/rbac/meta', authorize('roles'), rbac.rbacMeta);
r.get('/roles', authorize('roles'), rbac.listRoles);
r.post('/roles', authorize('roles', 'create'), rbac.createRole);
r.patch('/roles/:id/permissions', authorize('roles', 'update'), rbac.updateRolePermissions);
r.delete('/roles/:id', authorize('roles', 'delete'), rbac.deleteRole);

// Users / employees
r.get('/users', authorize('employees'), rbac.listUsers);
r.get('/users/orgchart', authorize('orgchart'), rbac.orgChart);
r.get('/users/deleted', authorize('employees'), rbac.listDeletedEmployees);
r.post('/users', authorize('employees', 'create'), rbac.createUser);
r.patch('/users/:id', authorize('employees', 'update'), rbac.updateUser);
r.delete('/users/:id', authorize('employees', 'delete'), rbac.deleteUser);
r.post('/users/:id/delete', authorize('employees', 'delete'), rbac.deleteEmployee);
r.post('/users/:id/restore', authorize('employees', 'update'), rbac.restoreEmployee);

export default r;
