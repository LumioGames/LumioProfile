import type { ControlChannel, ControlRequest } from './types.ts';
/** Adapts an already opened, host-owned socket. Does not create connections. */
export function websocketChannel(socket: {
  readyState: number; bufferedAmount: number; send(data: string): void;
  addEventListener(type: string, callback: any): void; removeEventListener(type: string, callback: any): void;
}, maxMessageBytes = 32 * 1024 * 1024): ControlChannel {
  return {
    subscribe(handler) {
      const listener = (event: { data: unknown }) => {
        if (typeof event.data !== 'string' || event.data.length > 65536) return;
        try { const r = JSON.parse(event.data) as ControlRequest; if (typeof r.id === 'string' && r.id.length < 128 && typeof r.method === 'string') handler(r); } catch { /* invalid control envelope */ }
      };
      socket.addEventListener('message', listener);
      return () => socket.removeEventListener('message', listener);
    },
    send(response) {
      if (socket.readyState !== 1 || socket.bufferedAmount > 65536) throw new Error('diagnostic-transport-busy');
      const data = JSON.stringify(response);
      if (data.length * 2 > maxMessageBytes) throw new Error('diagnostic-export-too-large');
      socket.send(data);
    }
  };
}
