// server/src/sockets/io.ts
import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { verifyToken } from '../utils/jwt.js';
import { env } from '../config/env.js';
import type { ServerToClientEvents, ClientToServerEvents } from '../types/socket.js';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;

let io: IOServer | null = null;

export function initSocket(httpServer: HttpServer): IOServer {
  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: env.clientOrigin, credentials: true },
  });

  // Authenticate socket handshake with the same JWT
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      socket.user = verifyToken(token);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // Clients join rooms to scope what they receive — saves bandwidth
    socket.join('dashboard');

    socket.on('subscribe:machine', (machineId) => {
      socket.join(`machine:${machineId}`);
    });
    socket.on('unsubscribe:machine', (machineId) => {
      socket.leave(`machine:${machineId}`);
    });
    socket.on('subscribe:dashboard', () => socket.join('dashboard'));

    socket.on('disconnect', () => {});
  });

  console.log('[socket] initialized');
  return io;
}

export const getIO = (): IOServer | null => io;
