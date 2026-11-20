// WebSocket client with request/response refs and automatic reconnect.
export type Msg = Record<string, any>;
export type NetStatus = "connecting" | "open" | "closed";

export class Net {
  private url: string;
  private ws: WebSocket | null = null;
  private ref = 0;
  private pending = new Map<number, { res: (m: Msg) => void; rej: (e: Error) => void; timer: number }>();
  private backoff = 500;
  private waiters: (() => void)[] = [];
  onMessage: (m: Msg) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};
  onOpen: () => void = () => {};
  onUnsolicitedError: (msg: string) => void = () => {};

  constructor(url: string) {
    this.url = url;
    document.addEventListener("visibilitychange", () => {
      // Laptops that slept come back with a dead socket; reconnect straight away.
      if (document.visibilityState === "visible" && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
    window.addEventListener("online", () => this.connect());
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.onStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.onStatus("open");
      this.onOpen();
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    };
    ws.onmessage = (e) => {
      let m: Msg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      const p = m.ref !== undefined ? this.pending.get(m.ref) : undefined;
      if (p) {
        this.pending.delete(m.ref);
        clearTimeout(p.timer);
        if (m.t === "error") p.rej(new Error(m.msg));
        else p.res(m);
      } else if (m.t === "error") {
        this.onUnsolicitedError(m.msg);
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.rej(new Error("Connection lost. Reconnecting…"));
      }
      this.pending.clear();
      this.onStatus("closed");
      setTimeout(() => this.connect(), this.backoff + Math.random() * 300);
      this.backoff = Math.min(8000, this.backoff * 2);
    };
  }

  private ready(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connect();
    return new Promise((r) => this.waiters.push(r));
  }

  async call(m: Msg): Promise<Msg> {
    await this.ready();
    const ref = ++this.ref;
    return new Promise((res, rej) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(ref);
        rej(new Error("The server didn't answer. Try again."));
      }, 10_000);
      this.pending.set(ref, { res, rej, timer });
      this.ws!.send(JSON.stringify({ ...m, ref }));
    });
  }
}
