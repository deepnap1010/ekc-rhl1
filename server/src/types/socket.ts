// Socket.io event maps and a module augmentation so `socket.user` is typed.
// The handshake middleware attaches the verified JWT payload to `socket.user`
// (kept as a direct property to preserve the original runtime behavior).
import type { JwtPayload } from './auth.js';

// Events the server emits to clients.
export interface ServerToClientEvents {
  'machine:tick': (tick: MachineTick) => void;
  'machine:update': (doc: Record<string, unknown>) => void;
  'machine:removed': (payload: { id: unknown }) => void;
  'telemetry:new': (payload: TelemetryPayload) => void;
}

// Events clients emit to the server.
export interface ClientToServerEvents {
  'subscribe:machine': (machineId: string) => void;
  'unsubscribe:machine': (machineId: string) => void;
  'subscribe:dashboard': () => void;
}

// Compact machine projection broadcast to the dashboard room.
export interface MachineTick {
  machineId: string;
  code?: string;
  name?: string;
  type?: string;
  status?: string;
  oee?: number;
  totalOutput?: number;
  currentParameters: Record<string, unknown>;
  lastReadingAt?: Date;
}

// Telemetry payload pushed on new readings.
export interface TelemetryPayload {
  machineId: string;
  timestamp?: Date;
  data: Record<string, unknown>;
  _id?: unknown;
  receivedAt?: Date;
}

declare module 'socket.io' {
  interface Socket {
    user?: JwtPayload;
  }
}
