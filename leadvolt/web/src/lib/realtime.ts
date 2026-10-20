import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';

export interface RtEvent { seq: number; type: string; data: any; ts: string }
type Handler = (e: RtEvent) => void;
let socket: Socket | null = null;
const handlers = new Set<Handler>();
const connectionHandlers = new Set<(connected: boolean) => void>();
const subscriptions = new Map<string, number>();
export const isConnected = () => !!socket?.connected;

export function connectRealtime() {
  if (socket || !getToken()) return;
  socket = io({ path: '/ws', auth: { token: getToken() }, transports: ['websocket'] });
  socket.on('event', (e: RtEvent) => handlers.forEach(h => h(e)));
  socket.on('connect', () => {
    subscriptions.forEach((_, id) => socket?.emit('lead:subscribe', id));
    connectionHandlers.forEach(h => h(true));
  });
  socket.on('disconnect', () => connectionHandlers.forEach(h => h(false)));
}
export function onEvent(h: Handler) { handlers.add(h); return () => { handlers.delete(h); }; }
export function subscribeLead(id: string) {
  const count = subscriptions.get(id) ?? 0;
  subscriptions.set(id, count + 1);
  if (count === 0 && isConnected()) socket?.emit('lead:subscribe', id);
  return () => {
    const remaining = (subscriptions.get(id) ?? 1) - 1;
    if (remaining > 0) subscriptions.set(id, remaining);
    else { subscriptions.delete(id); socket?.emit('lead:unsubscribe', id); }
  };
}
export function useRealtimeStatus() {
  const [connected, setConnected] = useState(isConnected);
  useEffect(() => { connectionHandlers.add(setConnected); setConnected(isConnected()); return () => { connectionHandlers.delete(setConnected); }; }, []);
  return connected;
}
