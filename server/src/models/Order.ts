// server/src/models/Order.ts
// A production order: make `quantity` pieces of one DIA. Progress is DERIVED —
// pieces counted on machines running that DIA since the order opened — never
// typed in, so an order can't disagree with the counters.
import mongoose from 'mongoose';

export interface IOrder {
  orderNo: string;                 // unique, the plant's own numbering
  diaId: mongoose.Types.ObjectId;
  diaName: string;                 // denormalized label (frozen at creation)
  quantity: number;
  status: 'open' | 'done' | 'cancelled';
  notes: string;
  startedAt: Date;                 // progress counts from here
  closedAt: Date | null;
  createdBy?: { id?: string; name?: string };
}

const schema = new mongoose.Schema<IOrder>(
  {
    orderNo: { type: String, required: true, unique: true, trim: true },
    diaId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiaConfig', required: true },
    diaName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open', index: true },
    notes: { type: String, default: '' },
    startedAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
    createdBy: { id: String, name: String },
  },
  { collection: 'orders', versionKey: false, timestamps: true },
);

export const Order = mongoose.model<IOrder>('Order', schema);
