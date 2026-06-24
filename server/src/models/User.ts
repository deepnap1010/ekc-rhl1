// server/src/models/User.ts
import mongoose, { type Model, type Types, type HydratedDocument } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface Deletion {
  type: 'temporary' | 'permanent';
  reason: string;
  at: Date | null;
  by: Types.ObjectId | null;
  from: Date | null;
  until: Date | null;
}

export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  role: Types.ObjectId | null;
  isSuperAdmin: boolean;
  plant: string;
  reportsTo: Types.ObjectId | null;
  assignedMachines: string[];
  avatar: string; // profile photo as a compressed data URL ('' = use default icon)
  active: boolean;
  lastLoginAt?: Date;
  deletion?: Deletion | null;
}

export interface IUserMethods {
  setPassword(plain: string): Promise<void>;
  verifyPassword(plain: string): Promise<boolean>;
}

export type UserModel = Model<IUser, Record<string, never>, IUserMethods>;
export type UserDocument = HydratedDocument<IUser, IUserMethods>;

const userSchema = new mongoose.Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: { type: String, required: true, select: false },

    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null }, // optional: super admins need none
    isSuperAdmin: { type: Boolean, default: false }, // bypasses all permission checks

    plant: { type: String, default: '' },
    reportsTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // org chart
    assignedMachines: { type: [String], default: [] }, // machineIds for operators
    avatar: { type: String, default: '' }, // profile photo (compressed data URL), display-only

    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date },

    // Employee lifecycle — null when active; set on temporary suspension / permanent removal.
    deletion: {
      type: new mongoose.Schema(
        {
          type: { type: String, enum: ['temporary', 'permanent'] },
          reason: { type: String, default: '' },
          at: { type: Date, default: null },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          from: { type: Date, default: null },
          until: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain: string): Promise<void> {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.verifyPassword = function (plain: string): Promise<boolean> {
  return bcrypt.compare(plain, this.passwordHash);
};

export const User = mongoose.model<IUser, UserModel>('User', userSchema);
