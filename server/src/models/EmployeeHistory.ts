// server/src/models/EmployeeHistory.ts
// Tombstone for PERMANENTLY removed employees. When an employee is permanently
// deleted we hard-delete the User document (so the email is freed for re-use and
// the unique index no longer blocks re-creation) and write a read-only snapshot
// here instead. The Employee History view reads permanent records from this
// collection (temporary suspensions still live on the User doc).
//
// NOTE: `email` is intentionally NOT unique — the same person can be hired and
// terminated more than once, and each termination is its own historical record.
import mongoose from 'mongoose';

export interface IEmployeeHistory {
  userId: mongoose.Types.ObjectId | null; // original _id (reference only)
  name: string;
  email: string;
  plant: string;
  roleName: string | null;
  roleKey: string | null;
  isSuperAdmin: boolean;
  assignedMachines: string[];
  reason: string;                          // why they were removed
  at: Date;                                // when removed
  by: mongoose.Types.ObjectId | null;      // who removed them
  joinedAt: Date | null;                   // original account creation
}

const employeeHistorySchema = new mongoose.Schema<IEmployeeHistory>(
  {
    userId:           { type: mongoose.Schema.Types.ObjectId, default: null },
    name:             { type: String, required: true },
    email:            { type: String, required: true, lowercase: true },
    plant:            { type: String, default: '' },
    roleName:         { type: String, default: null },
    roleKey:          { type: String, default: null },
    isSuperAdmin:     { type: Boolean, default: false },
    assignedMachines: { type: [String], default: [] },
    reason:           { type: String, default: '' },
    at:               { type: Date, default: () => new Date() },
    by:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    joinedAt:         { type: Date, default: null },
  },
  { timestamps: true }
);

employeeHistorySchema.index({ at: -1 });    // history is listed newest-removal first
employeeHistorySchema.index({ email: 1 });

export const EmployeeHistory = mongoose.model<IEmployeeHistory>('EmployeeHistory', employeeHistorySchema, 'employee_history');
