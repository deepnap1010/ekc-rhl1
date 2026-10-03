// server/src/models/CounterKeyMemo.ts
// What each machine's production counter is CALLED — remembered.
//
// The name used to be read off the machine's newest reading every time it was
// needed, and a reading does not always carry it: a collector sends a shorter
// payload while its PLC is off, and two agents on one PC send two register
// lists turn about. For as long as the newest reading was a short one the
// machine read "cannot count", for shifts it had counted perfectly well.
//
// One row per machine, written by the 30-second sweep the first time a reading
// names a counter and again only if the name changes. Kept OUT of the
// `machines` collection on purpose — that one mirrors the factory's own system
// and is not ours to write.
import mongoose from 'mongoose';

export interface ICounterKeyMemo {
  machineRef: string;   // the machine's code, UPPER-CASED (aliases differ only by case here)
  key: string;          // the telemetry key, e.g. "production_count"
  seenAt: Date;         // when a reading last taught us this name
}

const schema = new mongoose.Schema<ICounterKeyMemo>(
  {
    machineRef: { type: String, required: true, unique: true, index: true },
    key: { type: String, required: true },
    seenAt: { type: Date, required: true },
  },
  { collection: 'machine_counter_keys', versionKey: false },
);

export const CounterKeyMemo = mongoose.model<ICounterKeyMemo>('CounterKeyMemo', schema);
