// server/src/models/MachineEvent.ts
// Operational event log — the app-owned layer between raw telemetry and the UI
// (same ownership model as downtime_reports: we WRITE this collection; machines/
// telemetries stay read-only mirrors). Two kinds:
//
//   state       — a state SESSION (running / idle / stopped / offline) with
//                 open/close semantics: endedAt null while the state is current,
//                 closed with a durationMs on the next transition. Repeated
//                 identical statuses never create new rows (1 session, not N).
//   production  — a point event: the machine's production counter advanced.
//                 prevValue → newValue with the delta; counter resets are
//                 recorded with meta.reset and no fabricated delta.
//
// Events are created ONLY by the sweep in downtime.service (one transition
// detector for both this log and downtime_reports, so History and Downtime can
// never disagree). Forward-looking — nothing is backfilled or fabricated.
import mongoose from 'mongoose';

export type EventKind = 'state' | 'production';
export type EventState = 'running' | 'idle' | 'stopped' | 'offline';

export interface IMachineEvent {
  machineId: string;                    // Machine.code (or raw machineId alias)
  kind: EventKind;
  state?: EventState;                   // kind=state: the session's state
  prevState?: EventState | null;        // state before this session (null = first observation)
  paramKey?: string;                    // kind=production: the counter key used
  prevValue?: number;
  newValue?: number;
  delta?: number;                       // production increment (0 on reset)
  startedAt: Date;                      // point events: occurrence time
  endedAt?: Date | null;                // null = session still active (state kind only)
  durationMs?: number;
  meta?: Record<string, unknown>;
  // kind=production only: what this counter advance WAS (OK / DRY_CYCLE /
  // DEFECTIVE / SAMPLE). Stamped with the admin-configured default at birth —
  // so no event is ever unclassified, a popup timeout needs no write to
  // "apply" anything, and a later change to the default cannot rewrite
  // history. classSource says who had the last word.
  classification?: string;
  classSource?: 'default' | 'operator' | 'timeout' | 'edit';
  classifiedBy?: { id?: string; name?: string };
  classifiedAt?: Date | null;
  operatorName?: string | null;         // who was on the machine when the counter moved
  editReason?: string | null;           // why a past classification was changed (classSource 'edit')
}

const machineEventSchema = new mongoose.Schema<IMachineEvent>(
  {
    machineId: { type: String, required: true },
    kind:      { type: String, required: true, enum: ['state', 'production'] },
    state:     { type: String, enum: ['running', 'idle', 'stopped', 'offline'] },
    prevState: { type: String, default: null },
    paramKey:  { type: String },
    prevValue: { type: Number },
    newValue:  { type: Number },
    delta:     { type: Number },
    startedAt: { type: Date, required: true },
    endedAt:   { type: Date, default: null },
    durationMs:{ type: Number, default: 0 },
    meta:      { type: mongoose.Schema.Types.Mixed },
    classification: { type: String },
    classSource:    { type: String, enum: ['default', 'operator', 'timeout', 'edit'] },
    classifiedBy:   { type: new mongoose.Schema({ id: String, name: String }, { _id: false }) },
    classifiedAt:   { type: Date, default: null },
    operatorName:   { type: String, default: null },
    editReason:     { type: String, default: null },
  },
  { collection: 'machine_events', versionKey: false }
);

machineEventSchema.index({ machineId: 1, startedAt: -1 });
machineEventSchema.index({ startedAt: -1 });
machineEventSchema.index({ kind: 1, startedAt: -1 });
// Fast "current open session per machine" lookup for the sweep.
machineEventSchema.index(
  { machineId: 1, startedAt: -1 },
  { name: 'open_sessions_idx', partialFilterExpression: { kind: 'state', endedAt: null } }
);

export const MachineEvent = mongoose.model<IMachineEvent>('MachineEvent', machineEventSchema);
