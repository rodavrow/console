// The programming cable through Chrome's Web Serial: 115200 8N1, raised with BAUD after HELLO (LINK-11, LINK-13.3).
import type { Transport } from "./types";

// Minimal Web Serial types (not in TypeScript's DOM library).
type SerialPortLike = {
  open(o: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  addEventListener(t: "disconnect", f: () => void): void;
};
type SerialLike = {
  requestPort(o?: { filters: { usbVendorId: number }[] }): Promise<SerialPortLike>;
  getPorts?(): Promise<SerialPortLike[]>;
};

/** USB-serial chips programming cables use: CH340 (the RT-950 Pro's cable), CP210x, FTDI, Prolific. */
const FILTERS = [0x1a86, 0x10c4, 0x0403, 0x067b].map((usbVendorId) => ({ usbVendorId }));

export const webSerial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;

export class WebSerialTransport implements Transport {
  readonly kind = "cable" as const;
  readonly slow = false;
  label = "Cable";
  baud = 115200;
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loop: Promise<void> = Promise.resolve();
  private closing = false;
  private queue: Promise<void> = Promise.resolve();
  private port: SerialPortLike;

  // A plain field, not a parameter property: Node's type stripping (the unit tests) can't run those.
  private constructor(port: SerialPortLike) {
    this.port = port;
  }

  static async request(): Promise<WebSerialTransport> {
    const serial = webSerial();
    if (!serial) throw new Error("This browser has no Web Serial: use Chrome, Edge or Firefox on a desktop.");
    return WebSerialTransport.fromPort(await serial.requestPort({ filters: FILTERS }));
  }

  private static async fromPort(port: SerialPortLike): Promise<WebSerialTransport> {
    const t = new WebSerialTransport(port);
    await t.openAt(115200);
    port.addEventListener("disconnect", () => {
      if (!t.closing) t.onClose("The cable was unplugged.");
    });
    const info = port.getInfo();
    if (info.usbVendorId === 0x1a86) t.label = "Cable (CH340)";
    return t;
  }

  /**
   * The same cable again, from the ports this page was already granted (no chooser): the same port if it's back,
   * else the one port of the same USB chip. Throws while it isn't plugged in.
   */
  async reopen(): Promise<WebSerialTransport> {
    const ports = (await webSerial()?.getPorts?.()) ?? [];
    const was = this.port.getInfo();
    const same = (p: SerialPortLike) => {
      const i = p.getInfo();
      return i.usbVendorId === was.usbVendorId && i.usbProductId === was.usbProductId;
    };
    const alike = ports.filter((p) => p !== this.port && same(p));
    const tries = [...ports.filter((p) => p === this.port), ...(alike.length === 1 ? alike : [])];
    let last: unknown = new Error("The cable isn't back yet.");
    for (const p of tries) {
      try {
        return await WebSerialTransport.fromPort(p);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  private async openAt(rate: number) {
    await this.port.open({ baudRate: rate, dataBits: 8, stopBits: 1, parity: "none", bufferSize: 8192 });
    this.baud = rate;
    this.reader = this.port.readable!.getReader();
    const reader = this.reader;
    this.loop = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) this.onData(value);
        }
      } catch (e) {
        if (!this.closing) this.onClose(`The cable stopped: ${(e as Error).message}`);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private async shut() {
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    await this.loop;
    await this.port.close();
  }

  /** Whole writes one after another: a write holds the stream's only writer until its bytes are out, and Link sends
   *  two frames back to back (LINK-41.1). Unqueued, the second found the stream locked and was never sent. */
  write(bytes: Uint8Array): Promise<void> {
    const run = async () => {
      const w = this.port.writable!.getWriter();
      try {
        await w.write(bytes);
      } finally {
        w.releaseLock();
      }
    };
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {}); // a failed write is the caller's to see; the next one still goes
    return r;
  }

  /** Closes and reopens the port at `rate` (Web Serial can't change a port's rate in place). */
  async setBaud(rate: number) {
    if (rate === this.baud) return;
    this.closing = true;
    try {
      await this.shut();
      await this.openAt(rate);
    } finally {
      this.closing = false;
    }
  }

  async close() {
    this.closing = true;
    try {
      await this.shut();
    } catch {
      /* unplugged */
    }
  }
}
