// server/src/models/Telemetry.ts
// READ-ONLY mirror of the real `test.telemetries` collection (a plain collection,
// NOT time-series). One document per reading. We only ever read + watch it.
//   machineId  -> matches Machine.code
//   timestamp  -> when the reading was taken
//   data       -> schema-agnostic metric map (varies by machine type)
import mongoose from 'mongoose';

export interface ITelemetry {
  machineId?: string;
  machineName?: string;
  machineType?: string;
  timestamp?: Date;
  receivedAt?: Date;
  // Schema-agnostic metric map (Mixed): keys vary per machine type.
  data?: Record<string, unknown>;
}

const telemetrySchema = new mongoose.Schema<ITelemetry>(
  {
    machineId:   { type: String, index: true },
    machineName: { type: String },
    machineType: { type: String },
    timestamp:   { type: Date },
    receivedAt:  { type: Date },
    data:        { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { strict: false, collection: 'telemetries', versionKey: false }
);

// The history query is always: this machine, newest first → make it index-covered & fast at scale.
telemetrySchema.index({ machineId: 1, timestamp: -1 });

export const Telemetry = mongoose.model<ITelemetry>('Telemetry', telemetrySchema);
