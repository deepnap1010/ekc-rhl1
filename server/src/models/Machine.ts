// server/src/models/Machine.ts
// READ-ONLY mirror of the real `test.machines` collection.
// The factory's own system owns these documents — we never write them.
// `strict: false` lets any future fields flow through untouched.
import mongoose, { type Types } from 'mongoose';

export interface IMachine {
  name?: string;
  code?: string;
  type?: string;
  plant?: Types.ObjectId;
  status?: string;
  // Raw mirror aliases — present when the factory doc has no `code`/`name`/`type`.
  machineId?: string;
  machineName?: string;
  machineType?: string;
  // Schema-agnostic live snapshot / thresholds (Mixed): keys vary per machine type.
  currentParameters?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  ratedCapacity?: number;
  oee?: number;
  totalOutput?: number;
  lastReadingAt?: Date;
  lastSeenAt?: Date;
  installedOn?: Date;
}

const machineSchema = new mongoose.Schema<IMachine>(
  {
    name:   { type: String },
    code:   { type: String, index: true },   // business key, e.g. "TARAPUR-M01" — links telemetry.machineId
    type:   { type: String, index: true },   // "Billet Heating Furnace", "Heat Treatment", ...
    plant:  { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', index: true },
    status: { type: String, index: true },   // "running" | "idle" | "stopped" | "offline" | ...

    // Raw mirror aliases — declared so strict queries (findOne) can filter on them
    // (the collection is owned externally; these arrive when `code` is absent).
    machineId:   { type: String, index: true },
    machineName: { type: String },
    machineType: { type: String },

    // Latest live snapshot pushed by the factory system (schema-agnostic per machine type)
    currentParameters: { type: mongoose.Schema.Types.Mixed, default: {} },
    thresholds:        { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { temperatureMax: 1250 }

    ratedCapacity: { type: Number },
    oee:           { type: Number },   // Overall Equipment Effectiveness (%)
    totalOutput:   { type: Number },   // cumulative production
    lastReadingAt: { type: Date },
    lastSeenAt:    { type: Date },   // server-receipt time of the last payload (set by ingest)
    installedOn:   { type: Date },
  },
  { timestamps: true, strict: false, collection: 'machines' }
);

// Common dashboard access + list-sort patterns
machineSchema.index({ plant: 1, status: 1 });
machineSchema.index({ type: 1, status: 1 });
machineSchema.index({ name: 1 });
machineSchema.index({ lastReadingAt: -1 });

export const Machine = mongoose.model<IMachine>('Machine', machineSchema);
