// server/src/models/AppConfig.ts
// Shared application configuration — ONE document (key: 'global') in the
// app-owned `app_config` collection, so every desktop sees the same shifts,
// product catalog and process stages (previously per-device localStorage).
// Never touches machines/telemetries.
import mongoose from 'mongoose';

export interface IShift { name: string; start: string; end: string }
// A planned daily pause (lunch, tea) — HH:MM, plant clock. Targets exclude it.
export interface IBreak { name: string; start: string; end: string }

// The plant's stage vocabulary, in flow order — Cutting → SPG → Bottom Milling…
// A TEMPLATE only: every DIA still carries its own per-stage processing time
// (the same stage runs at different speeds for different products), and that
// copy is what a machine is held to. This list decides which stages a NEW dia
// starts with, and defaultSec pre-fills their times. 0 = "ask the admin".
export interface IStageTemplate { name: string; defaultSec: number }

export interface IAppConfig {
  key: string;                 // always 'global' (singleton)
  shifts: IShift[];
  breaks: IBreak[];
  stageTemplates: IStageTemplate[];
  products: string[];
  processStages: string[];
  updatedBy?: string;
}

const shiftSchema = new mongoose.Schema<IShift>(
  { name: { type: String, required: true }, start: { type: String, required: true }, end: { type: String, required: true } },
  { _id: false }
);

const appConfigSchema = new mongoose.Schema<IAppConfig>(
  {
    key:           { type: String, required: true, unique: true },
    shifts:        { type: [shiftSchema], default: [] },
    breaks:        { type: [shiftSchema], default: [] },   // same {name,start,end} shape
    stageTemplates: { type: [new mongoose.Schema<IStageTemplate>(
      { name: { type: String, required: true }, defaultSec: { type: Number, default: 0 } },
      { _id: false },
    )], default: [] },
    products:      { type: [String], default: [] },
    processStages: { type: [String], default: [] },
    updatedBy:     { type: String },
  },
  { collection: 'app_config', versionKey: false, timestamps: true }
);

export const AppConfig = mongoose.model<IAppConfig>('AppConfig', appConfigSchema);
