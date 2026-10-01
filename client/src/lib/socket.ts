// client/src/lib/socket.ts
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store/auth';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  const token = useAuthStore.getState().accessToken;
  socket = io('/', {
    auth: { token },
    autoConnect: true,
  });
  return socket;
}

/** The session renewed: the next (re)connection must carry the new token —
 *  the handshake is checked server-side, and a socket that reconnects with
 *  an expired token is refused for good, which is a board gone quiet. */
export function refreshSocketAuth(token: string): void {
  if (!socket) return;
  socket.auth = { token };
  if (!socket.connected) socket.connect();
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
