import { WS_BASE } from '../config';

// Singleton WS manager — deliberately NOT a React hook itself, so the
// connection survives tab switches/remounts. Mirrors the vanilla app's
// ensureWs()/sendWs(): connect once, send {type:'auth', token} as the first
// message, and hold any sends until the server replies {type:'authed'}.
export type WsMessage = { type: string; [key: string]: unknown };
type Listener = (msg: WsMessage) => void;

class SocketManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private authed = false;
  private connecting: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private closeListeners = new Set<() => void>();

  ensure(token: string): Promise<void> {
    if (this.ws && this.authed && this.token === token) return Promise.resolve();
    if (this.connecting && this.token === token) return this.connecting;
    this.close();
    this.token = token;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (e) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'authed') {
          this.authed = true;
          this.connecting = null;
          resolve();
        }
        this.listeners.forEach((fn) => fn(msg));
      };
      ws.onerror = () => {
        this.connecting = null;
        reject(new Error('서버에 연결할 수 없습니다.'));
      };
      ws.onclose = () => {
        this.authed = false;
        this.connecting = null;
        if (this.ws === ws) this.ws = null;
        this.closeListeners.forEach((fn) => fn());
      };
    });
    return this.connecting;
  }

  async send(token: string, msg: WsMessage) {
    await this.ensure(token);
    this.ws?.send(JSON.stringify(msg));
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.authed = false;
    this.token = null;
    this.connecting = null;
  }
}

export const socket = new SocketManager();
