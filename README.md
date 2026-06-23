# EKC SmartFactory

Industrial IoT production monitoring platform for Everest Kanto Cylinder (EKC).
Full MERN stack — live PLC telemetry, schema-agnostic ingestion, dynamic RBAC.

Built by ITSYBIZZ AI Private Limited.

## Stack
- **Backend:** Node + Express + MongoDB (Mongoose) + Socket.io
- **Frontend:** Vite + React + Tailwind + React Query + Zustand + Recharts
- **Live data:** Socket.io rooms (dashboard + per-machine), 202-accept ingest API

## Architecture (why it's fast)
- **Two-collection split:** `Machine` holds only the latest snapshot (small, fast reads for dashboards). `Telemetry` is a native MongoDB **time-series** collection for high-volume PLC readings (compressed, fast range queries).
- **Schema-agnostic `data`:** each machine type sends its own metric keys (e.g. `depth_of_cutting`, `servo_slow`). The UI renders whatever keys arrive — no schema change needed for a new machine.
- **Single-aggregation dashboards:** KPI cards come from one `$group` per metric, not N queries.
- **Room-scoped sockets:** clients only receive ticks for what they're viewing.
- **Lean reads + compression + pooling:** `.lean()` everywhere, gzip on, pool size 20.

## Setup

### 1. Backend
```bash
cd server
cp .env.example .env        # edit MONGO_URI, JWT_SECRET, INGEST_KEY
npm install
npm run seed                # creates admin + system roles + demo machines
npm run dev                 # http://localhost:5000
```
Login: `admin@ekc.in` / `admin123`

### 2. Frontend
```bash
cd client
npm install
npm run dev                 # http://localhost:5173 (proxies /api + /socket.io)
```

### 3. PLC agent (per machine)
```bash
cd plc-agents
pip install requests
python example_agent.py     # edit MACHINE_ID, INGEST_URL, read_plc()
```
Agents POST to `/api/v1/ingest` with header `x-ingest-key`. Server returns `202`.

## RBAC
Roles hold a `module -> [actions]` matrix. Modules: dashboard, machines, production,
quality, downtime, history, reports, employees, roles, orgchart, alerts, settings.
Actions: view, create, update, delete, execute, approve, admin.
Super Admin bypasses all checks. Frontend `can(module, action)` mirrors backend `authorize()`.

## Ingest payload
```json
{
  "machineId": "ekc_bottom_milling_01",
  "name": "EKC Bottom Milling 01",
  "type": "bottom_milling",
  "plant": "Tarapur",
  "deviceTs": "2026-06-15T07:50:43.960Z",
  "data": { "depth_of_cutting": 9500, "servo_slow": 700, "production": 24120, "efficiency": 78, "speed": 32 },
  "flags": [],
  "source": "plc"
}
```

## Status
Done: backend (auth, machines, dashboard, RBAC, telemetry, sockets, seed), frontend
(login, dashboard, machines, roles, employees, org chart). Stubs to extend with the
Machines.jsx pattern: downtime, history, reports.
