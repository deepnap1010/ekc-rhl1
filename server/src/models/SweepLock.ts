// server/src/models/SweepLock.ts
// One tiny document that decides WHICH server instance may write downtime spans.
// Without it every running instance swept the same database every 30s: the local
// dev server and the deployed one both opened/closed spans for the same machine,
// so a 12.5h day accumulated 14.9h of "downtime" and runtime collapsed to zero.
// A lease (not a flag) so a crashed leader can't block the sweep forever.
import mongoose from 'mongoose';

export interface ISweepLock {
  _id: string;        // lock name, e.g. 'downtime-sweep'
  owner: string;      // host:pid:nonce of the instance holding it
  heldUntil: Date;    // lease expiry — anyone may take over after this
}

const sweepLockSchema = new mongoose.Schema<ISweepLock>(
  {
    _id:       { type: String },
    owner:     { type: String, required: true },
    heldUntil: { type: Date, required: true },
  },
  { collection: 'app_locks', versionKey: false, timestamps: true },
);

export const SweepLock = mongoose.model<ISweepLock>('SweepLock', sweepLockSchema);
