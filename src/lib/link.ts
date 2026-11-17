// A link session over a transport, as ferrite_link.py's Link and Radio: the opening (Ctrl-C, then 0x00), one request
// at a time, answers matched by type and seq, a resync for read-only requests that got nothing, `busy` asked again,
// text answers paged with MORE, keys and the knob. Framing and parsing are the Rust core's.
import {
  P,
  Session,
  authPayload,
  baudPayload,
  helloPayload,
  helloPayloadPlain,
  keyPayload,
  knobPayloads,
  logReadPayload,
  msgDeletePayload,
  msgSendPayload,
  parseHeard,
  parseHello,
  parseLogPage,
  parseMsgs,
  parseInfo,
  parseTextChunk,
  recordReader,
  statusText,
  stateParse,
  subscribePayload,
  tunePayload,
  type Answer,
  type Hello,
  type Info,
  type Layouts,
  type LogRecord,
  type Message,
  type PlanOp,
  type Station,
} from "./core";
import { sleep, type Transport } from "./transport/types";
import { debugLog } from "./debuglog";

/** A message type's name for the debug log ("WRITE_MANY"). */
const msgName = (ty: number) => Object.entries(P.msg).find(([, v]) => v === ty)?.[0] ?? `0x${ty.toString(16)}`;
/** Asked every few hundred ms while Live View runs: logged only when they fail. */
const quiet = (ty: number) => ty === P.msg.UI || ty === P.msg.STATE;

export const CLIENT_NAME = "Ferrite Console";

/** Windows (the app or a browser): its serial stack and Console struggle above 115200, so the cable stays there. */
export const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** The rates Console raises the cable to, best first (LINK-13.3); none on Windows, which stays at 115200. */
export const cableFastRates = (): number[] => (IS_WINDOWS ? [] : P.timing.cable_fast_rates);

export class RadioError extends Error {
  constructor(
    readonly ty: number,
    readonly status: number,
    rest: Uint8Array = new Uint8Array(),
  ) {
    super(statusText(status, rest));
  }
}

export class TimeoutError extends Error {}

/** UPD-16: the radio's data waits in another layout (it shows D25 "Finish the update"): its records aren't there to
 *  read or write until Console moves the data (LINK-62). */
export class LayoutPending extends Error {
  constructor(readonly layouts: Layouts) {
    super(
      layouts.chip === 255
        ? "The radio's channels and settings are part way through a move: finish the update first (the banner at the top)."
        : `The radio's channels and settings are waiting in the old layout (layout ${layouts.chip}): finish the update first (the banner at the top, or Update Ferrite).`,
    );
  }
}

/** LINK-50: a stream's frame didn't come (lost on the way, or none in time); `got` is what came before it. */
export class StreamGap extends Error {
  constructor(readonly got: Uint8Array[]) {
    super(`A stream frame was lost after ${got.length}.`);
  }
}

type Waiter = { ty: number; seq: number; resolve: (a: Answer) => void };
/** LINK-50: frames of one STREAM, numbered from its request's seq. */
type StreamWaiter = { seq: number; frames: Uint8Array[]; done: (gap: boolean) => void; poke: () => void; onFrame?: (f: Uint8Array) => void };

const STREAM = 0x19;
const STREAM_MORE = 0x1a;

export class Link {
  private session = new Session();
  private waiters = new Map<number, Waiter>();
  private streamW: StreamWaiter | null = null;
  /** LINK-15.1: the module's `!!!!` answer to the speed unlock is dropped, not fed to the session. */
  private dropUnlock = false;
  /** LINK-35.2: HELLO's capability byte (`P.caps`: compression granted, receive audio on this port, line commands). */
  caps = 0;
  /** HELLO's protocol: `P.protocol`, or the radio can only be updated (decision 385; see `current`). */
  protocol = 0;
  /** LINK-62: the layouts HELLO gave (this firmware's, the chip's); null from a radio on another protocol. */
  layouts: Layouts | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private holdUntil = 0;
  private closed = false;
  /** Answers that matched nothing (late ones after a time-out), for the debug line. */
  stray = 0;
  /** Frames taken from the radio so far, and the frame each answer type last resolved at (LINK-67: Console's
   * STATE read tells which events came after its answer). */
  frames = 0;
  answeredAt = new Map<number, number>();
  /** Events (LINK-46): frames the radio sends unasked, never matched to a request: the frame's seq (the session's
   * event counter) and the payload (the kind, then its bytes). */
  onEvent: (seq: number, payload: Uint8Array) => void = () => {};
  /** LINK-13.4: receive audio blocks (`AUDIO_DATA` payloads) while listening. */
  onAudio: (payload: Uint8Array) => void = () => {};

  constructor(readonly t: Transport) {
    t.onData = (bytes) => {
      if (this.closed) return;
      if (this.dropUnlock && bytes.length >= 4 && bytes[0] === 0x21 && bytes[1] === 0x21 && bytes[2] === 0x21 && bytes[3] === 0x21) {
        this.dropUnlock = false;
        return;
      }
      const answers: Answer[] = JSON.parse(this.session.feed(bytes));
      for (const a of answers) {
        this.frames++;
        if (a.event && a.ty === P.msg.AUDIO_DATA) {
          this.onAudio(new Uint8Array(a.rest));
          continue;
        }
        if (a.event) {
          this.onEvent(a.seq, new Uint8Array(a.rest));
          continue;
        }
        const s = this.streamW;
        if (s && (a.ty === (STREAM | 0x80) || a.ty === (STREAM_MORE | 0x80))) {
          if (a.seq !== (s.seq + s.frames.length) % 256) {
            s.done(true); // a frame lost on the way
            continue;
          }
          if (a.status !== 0) {
            s.frames.push(new Uint8Array([0xff, a.status, ...a.rest]));
            s.done(false);
            continue;
          }
          const f = new Uint8Array(a.rest);
          s.frames.push(f);
          s.poke();
          s.onFrame?.(f);
          if (a.ty === (STREAM | 0x80)) s.done(false);
          continue;
        }
        const w = this.waiters.get(a.seq);
        if (w && a.ty === (w.ty | 0x80)) {
          this.waiters.delete(a.seq);
          this.answeredAt.set(w.ty, this.frames);
          w.resolve(a);
        } else this.stray++;
      }
    };
  }

  /** TERM-2: Ctrl-C closes the radio's terminal if it holds the cable; its goodbye is dropped; 0x00 takes the cable. */
  async open() {
    await this.t.write(Session.opening());
    await sleep(P.timing.open_settle_ms);
    this.session.discard();
    await this.t.write(this.session.take_cable(performance.now()));
  }

  /** No more requests; whatever is in flight fails with "not connected". */
  close() {
    this.closed = true;
    for (const w of this.waiters.values()) w.resolve({ ty: 0, seq: 0, status: 0xff, rest: [] });
    this.waiters.clear();
    this.streamW?.done(true);
  }

  /** Runs `fn` when every request before it is done: one request on the link at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(async () => {
      const wait = this.holdUntil - performance.now();
      if (wait > 0) await sleep(wait); // a remote long press is still held
      return fn();
    }, fn);
    this.chain = r.catch(() => {});
    return r;
  }

  private timeout() {
    return this.t.slow ? P.timing.ble_timeout_ms : P.timing.cable_timeout_ms;
  }

  /** One request and its answer, not queued (callers hold `exclusive`). HELLO, INFO and UI get one resync. */
  private async askRaw(
    ty: number,
    payload: Uint8Array,
    timeoutMs = this.timeout(),
    resync = true,
  ): Promise<{ status: number; rest: Uint8Array }> {
    if (this.closed) throw new Error("not connected");
    const { HELLO, INFO, UI } = P.msg;
    let resynced = !resync;
    for (;;) {
      const seq = this.session.next_seq();
      const got = new Promise<Answer | null>((resolve) => {
        this.waiters.set(seq, { ty, seq, resolve });
        setTimeout(() => resolve(null), timeoutMs);
      });
      const sent = performance.now();
      await this.t.write(this.session.request(ty, payload, performance.now()));
      const a = await got;
      if (this.closed) throw new Error("not connected");
      if (a) {
        if (!quiet(ty) || a.status !== 0)
          debugLog(`link ${msgName(ty)} #${seq} ${payload.length} B: status ${a.status} in ${(performance.now() - sent).toFixed(0)} ms`);
        return { status: a.status, rest: new Uint8Array(a.rest) };
      }
      debugLog(`link ${msgName(ty)} #${seq} ${payload.length} B: NO ANSWER in ${timeoutMs} ms`);
      this.waiters.delete(seq);
      // A frame sent just after a restart or 10 s of quiet can go to the terminal (TERM-2): a read-only request is
      // sent once more after a 0x00. Never a KEY, CMD, MORE or write: those would act twice or skip a chunk.
      if (!resynced && this.caps & P.caps.LZ && ty !== HELLO) {
        resynced = true; // LINK-51: the windows may be apart: start them over, then ask again
        await this.resync();
        continue;
      }
      if (!resynced && (ty === HELLO || ty === INFO || ty === UI)) {
        resynced = true;
        await this.t.write(this.session.take_cable(performance.now()));
        continue;
      }
      throw new TimeoutError(`No answer from the radio in ${(timeoutMs / 1000).toFixed(0)} s.`);
    }
  }

  /** A request that must succeed; `busy` is asked again for up to 3 s (a long press still held, the store busy). */
  private async okRaw(ty: number, payload: Uint8Array = new Uint8Array(), timeoutMs?: number): Promise<Uint8Array> {
    const end = performance.now() + P.timing.busy_retry_ms;
    for (;;) {
      const { status, rest } = await this.askRaw(ty, payload, timeoutMs);
      if (status === 0) return rest;
      if (status !== 7 || performance.now() > end) throw new RadioError(ty, status, rest);
      await sleep(P.timing.busy_sleep_ms);
    }
  }

  ask(ty: number, payload: Uint8Array = new Uint8Array(), timeoutMs?: number) {
    return this.exclusive(() => this.askRaw(ty, payload, timeoutMs));
  }

  ok(ty: number, payload: Uint8Array = new Uint8Array(), timeoutMs?: number) {
    return this.exclusive(() => this.okRaw(ty, payload, timeoutMs));
  }

  /** The radio speaks this Console's protocol (decision 385); otherwise it is only good for an update. */
  get current(): boolean {
    return this.protocol === P.protocol;
  }

  /**
   * HELLO. A radio on another protocol (decision 385: Ferrite 0.8.4 says 3) is asked once more without
   * compression: its capability byte means other things, so Console can't tell whether it granted it, and the
   * update needs plain frames (REBOOT).
   */
  async hello(): Promise<Hello> {
    return this.exclusive(async () => {
      const h = this.noteHello(await this.okRaw(P.msg.HELLO, helloPayload(CLIENT_NAME)));
      if (this.current) return h;
      return this.noteHello(await this.okRaw(P.msg.HELLO, helloPayloadPlain(CLIENT_NAME)));
    });
  }

  /**
   * HELLO without compression, and compression kept off: for Back to stock, whose loop on the radio (firmware
   * `tasks/restore.rs`) reads plain frames only. Compressed, the first PROGRAM (133 bytes) was never answered and the
   * restore stopped after one block (black, Nov 16, 2026: "The radio stopped answering during the restore").
   */
  async helloPlain(): Promise<Hello> {
    return this.exclusive(async () => {
      const h = this.noteHello(await this.okRaw(P.msg.HELLO, helloPayloadPlain(CLIENT_NAME)));
      this.caps &= ~P.caps.LZ;
      this.session.set_lz(false);
      debugLog("link HELLO plain: compression off");
      return h;
    });
  }

  /** LINK-35.2, LINK-51: a HELLO answer's caps; compression on from here when it granted it (both windows new). */
  private noteHello(rest: Uint8Array): Hello {
    const h = parseHello(rest);
    if (!h) throw new Error("The radio's HELLO answer didn't parse.");
    this.protocol = h.protocol;
    this.caps = this.current ? h.caps : 0;
    this.layouts = h.layouts ?? null;
    this.session.set_lz((this.caps & P.caps.LZ) !== 0);
    return h;
  }

  /** A HELLO after the first (a resync, a new rate): as the first, without compression from a radio on another
   *  protocol. */
  private helloAgain() {
    return this.current ? helloPayload(CLIENT_NAME) : helloPayloadPlain(CLIENT_NAME);
  }

  /** LINK-51: after a lost frame while compressed, a HELLO starts both ends' windows over. */
  private async resync() {
    if (!(this.caps & P.caps.LZ)) return;
    debugLog("link resync (HELLO)");
    await sleep(300);
    const { status, rest } = await this.askRaw(P.msg.HELLO, this.helloAgain(), undefined, false);
    if (status === 0) this.noteHello(rest);
  }

  /**
   * LINK-15.1 (ferrite decision 285): over Bluetooth, the radio asked to 115200, the module unlocked (FF31's one
   * allowed write, by the transport), a HELLO to prove it. A radio from before refuses BAUD on Bluetooth and stays at
   * 9600; if the unlock or the HELLO fails, the radio goes back to 9600 by itself (3 s without a HELLO, or a framing
   * error) and the HELLO is asked again there. The rate in use.
   */
  bleFast(): Promise<number> {
    const t = this.t;
    if (!t.unlock) return Promise.resolve(0);
    const { BAUD, HELLO } = P.msg;
    return this.exclusive(async () => {
      const { status } = await this.askRaw(BAUD, baudPayload(115200));
      if (status !== 0) return 9600;
      await sleep(150); // the answer has left; the radio switches once its ring is empty
      this.dropUnlock = true;
      const unlocked = await t.unlock!().catch(() => false);
      await sleep(400);
      this.dropUnlock = false;
      for (let i = 0; i < 3; i++) {
        try {
          const { rest } = await this.askRaw(HELLO, this.helloAgain(), undefined, false);
          this.noteHello(rest);
          return unlocked ? 115200 : 9600;
        } catch {
          await sleep(500);
        }
      }
      this.noteHello(await this.okRaw(HELLO, this.helloAgain()));
      return 9600;
    });
  }

  /**
   * LINK-50: one STREAM of `ty`'s request (callers hold `exclusive`): its answers' payloads after the status, in
   * order. A frame missing throws StreamGap with what came; a refusal throws RadioError.
   */
  /** `onFrame`: each answer as it arrives (progress over a slow link), before the whole stream is in. */
  private async streamRaw(ty: number, payload: Uint8Array, onFrame?: (f: Uint8Array) => void): Promise<Uint8Array[]> {
    if (this.closed) throw new Error("not connected");
    const seq = this.session.next_seq();
    const frames: Uint8Array[] = [];
    const gap = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => w.done(true), this.timeout());
      };
      const w: StreamWaiter = {
        seq,
        frames,
        done: (g) => {
          clearTimeout(timer);
          if (this.streamW === w) this.streamW = null;
          resolve(g);
        },
        poke: arm,
        onFrame,
      };
      this.streamW = w;
      arm();
      void this.t.write(this.session.request(STREAM, new Uint8Array([ty, ...payload]), performance.now()));
    });
    this.session.skip(Math.max(frames.length, 1) + 1); // past the frames' seqs, and any still on the way
    const last = frames[frames.length - 1];
    if (last && last[0] === 0xff && !gap) throw new RadioError(STREAM, last[1], last.slice(2));
    if (gap) {
      await sleep(300); // what's still on its way goes with the gap
      await this.resync();
      throw new StreamGap(frames);
    }
    return frames;
  }

  /** UPD-16: the records are there only once the chip's data is in this firmware's layout. */
  private records() {
    if (this.layouts && this.layouts.firmware !== this.layouts.chip) throw new LayoutPending(this.layouts);
  }

  /**
   * LINK-59, LINK-60: one raw data request (`DATA_READ` or `DATA_WRITE`, its payload as the core's plan builds it),
   * its answer after the status. `busy` (the store still writing, or its queue full) is sent again for up to 20 s; no
   * answer is sent again twice (an erase or a program done twice leaves the same bytes; a read changes nothing).
   */
  data(ty: number, payload: Uint8Array, timeoutMs = 5000): Promise<Uint8Array> {
    return this.exclusive(async () => {
      let busyUntil = performance.now() + 20_000;
      for (let tries = 0; ; ) {
        let a: { status: number; rest: Uint8Array };
        try {
          a = await this.askRaw(ty, payload, timeoutMs, false);
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          if (++tries > 2) throw new TimeoutError(`${e.message} (${ty === P.msg.DATA_WRITE ? "DATA_WRITE" : "DATA_READ"} ${payload[0]} at 0x${new DataView(payload.buffer, payload.byteOffset).getUint32(1, true).toString(16)})`);
          continue;
        }
        if (a.status === 0) return a.rest;
        if (a.status === 7 && performance.now() < busyUntil) {
          await sleep(20);
          continue;
        }
        if (a.status !== 7) busyUntil = 0;
        throw new RadioError(ty, a.status, a.rest);
      }
    });
  }

  /** LINK-59: `len` bytes (1-232) at `addr`. */
  async dataRead(addr: number, len: number): Promise<Uint8Array> {
    const p = new Uint8Array(6);
    const d = new DataView(p.buffer);
    p[0] = P.data.READ;
    d.setUint32(1, addr, true);
    p[5] = len;
    const r = await this.data(P.msg.DATA_READ, p);
    if (r.length !== len) throw new Error(`DATA_READ at ${addr.toString(16)}: ${r.length} bytes, not ${len}`);
    return r;
  }

  /** LINK-59: the CRC-32 of `len` bytes at `addr`. */
  async dataCrc(addr: number, len: number): Promise<number> {
    const p = new Uint8Array(9);
    const d = new DataView(p.buffer);
    p[0] = P.data.CRC;
    d.setUint32(1, addr, true);
    d.setUint32(5, len, true);
    const r = await this.data(P.msg.DATA_READ, p, 15_000);
    return new DataView(r.buffer, r.byteOffset).getUint32(0, true);
  }

  /** LINK-30: the radio's PIN on Bluetooth while its PIN lock is on. */
  auth(pin: string) {
    return this.ok(P.msg.AUTH, authPayload(pin));
  }

  async info(): Promise<Info> {
    const i = parseInfo(await this.ok(P.msg.INFO));
    if (!i) throw new Error("The radio's INFO answer didn't parse.");
    return i;
  }

  /** A text answer (UI, CMD), paged with MORE, inside one `exclusive` so nothing else cuts in between pages. `enough`
   * stops the paging early (the radio's next command ends what is left). */
  text(ty: number, payload: Uint8Array, enough?: (soFar: string) => boolean): Promise<string> {
    return this.exclusive(async () => {
      if (ty === P.msg.UI) {
        // LINK-50: the pages back to back; a lost one asks the whole readback again
        for (let i = 0; i < 3; i++) {
          try {
            const frames = await this.streamRaw(ty, payload);
            return frames.map((f) => parseTextChunk(f)?.text ?? "").join("");
          } catch (e) {
            if (!(e instanceof StreamGap)) throw e;
          }
        }
        throw new StreamGap([]);
      }
      let out = "";
      let rest = await this.okRaw(ty, payload);
      for (;;) {
        const c = parseTextChunk(rest);
        if (!c) throw new Error("A text answer didn't parse.");
        out += c.text;
        if (!c.more || enough?.(out)) return out;
        if (c.working) await sleep(P.timing.more_wait_ms);
        rest = await this.okRaw(P.msg.MORE);
      }
    });
  }

  /** What the screen shows (LINK-19's readback): 0 the state; 3 with the screen as drawn (LINK-19.5), the default. */
  uiText(what = 3) {
    return this.text(P.msg.UI, new Uint8Array([what]));
  }

  cmd(line: string, enough?: (soFar: string) => boolean) {
    return this.text(P.msg.CMD, new TextEncoder().encode(line), enough);
  }

  /** `SLOT` (LINK-33): a slot's fields changed as the keypad would (`payload` from the core); the slot as it is after. */
  slot(payload: Uint8Array): Promise<Uint8Array> {
    return this.exclusive(() => this.okRaw(P.msg.SLOT, payload));
  }

  /** A keypad or side key (never PTT: the core has no name for one). A long press holds the link 800 ms after. */
  key(name: string, action: "short" | "long" | "down" | "up" = "short") {
    const p = keyPayload(name, action);
    return this.exclusive(async () => {
      await this.okRaw(P.msg.KEY, p);
      if (action === "long") this.holdUntil = performance.now() + P.timing.long_settle_ms;
    });
  }

  /** Knob steps, + clockwise; more than 20 go in several requests. */
  knob(steps: number) {
    const ps = knobPayloads(steps);
    return this.exclusive(async () => {
      for (const p of ps) await this.okRaw(P.msg.KEY, p);
    });
  }

  /**
   * LINK-11, LINK-13.3: raise the cable's rate. For each rate, best first: BAUD, then (50 ms after its answer) the
   * port switched and HELLO at the new rate within 1 s. A refusal tries the next rate; a HELLO that doesn't come
   * back puts the port back at 115200, waits out the radio's own fall-back, and HELLOs there. The rate in use.
   */
  raiseBaud(rates: number[] = cableFastRates()): Promise<number> {
    const t = this.t;
    if (!t.setBaud) return Promise.resolve(t.baud ?? 0);
    const { BAUD, HELLO } = P.msg;
    const { baud_switch_ms, baud_fallback_ms, cable_baud } = P.timing;
    return this.exclusive(async () => {
      for (const rate of rates) {
        const { status } = await this.askRaw(BAUD, baudPayload(rate));
        if (status !== 0) continue; // a rate this radio doesn't take
        const at = performance.now();
        await sleep(baud_switch_ms);
        await t.setBaud!(rate);
        try {
          await this.askRaw(HELLO, this.helloAgain(), Math.max(200, baud_fallback_ms - (performance.now() - at) - 100), false);
          return rate;
        } catch {
          await t.setBaud!(cable_baud);
          const left = baud_fallback_ms + 300 - (performance.now() - at);
          if (left > 0) await sleep(left);
          await t.write(this.session.take_cable(performance.now()));
          await this.okRaw(HELLO, this.helloAgain());
        }
      }
      return t.baud ?? cable_baud;
    });
  }

  /**
   * LINK-11: puts the cable back at 115200 before Console lets it go, so the flasher and the terminal find the radio
   * at its default rate (a raised rate otherwise stays until the radio restarts). BAUD 115200, the port switched,
   * a HELLO there; best effort, quietly.
   */
  lowerBaud(): Promise<void> {
    const t = this.t;
    const { BAUD, HELLO } = P.msg;
    const { baud_switch_ms, cable_baud } = P.timing;
    if (!t.setBaud || (t.baud ?? cable_baud) === cable_baud || this.closed) return Promise.resolve();
    return this.exclusive(async () => {
      const { status } = await this.askRaw(BAUD, baudPayload(cable_baud), 600, false);
      if (status !== 0) return;
      await sleep(baud_switch_ms);
      await t.setBaud!(cable_baud);
      try {
        await this.askRaw(HELLO, this.helloAgain(), 800, false);
      } catch {
        /* the radio falls back to 115200 by itself without it (LINK-11) */
      }
    });
  }

  /**
   * The page is going away: the BAUD 115200 request alone, written at once and not awaited. The radio switches
   * after answering, and with no HELLO stays at 115200 (LINK-11's fall-back).
   */
  releaseNow() {
    const base = P.timing.cable_baud;
    if (this.closed || !this.t.setBaud || (this.t.baud ?? base) === base) return;
    try {
      void this.t.write(this.session.request(P.msg.BAUD, baudPayload(base), performance.now()));
    } catch {
      /* gone already */
    }
  }

  /**
   * One record, read in parts of 200 bytes (LINK-21): its bytes, or null when the radio has none at that index
   * (`not found`). `busy` is asked again as for any request.
   */
  readRecord(what: number, index: number): Promise<Uint8Array | null> {
    return this.exclusive(async () => {
      this.records();
      const r = recordReader(what, index);
      try {
        while (!r.done()) {
          let rest: Uint8Array;
          try {
            rest = await this.okRaw(P.msg.READ, r.next_payload());
          } catch (e) {
            if (e instanceof RadioError && e.status === 8) return null;
            throw e;
          }
          if (!r.take(rest)) throw new Error("A READ answer didn't parse.");
        }
        return r.record();
      } finally {
        r.free();
      }
    });
  }

  /**
   * `run` whole-record writes from ops[i] as WRITE_MANY frames (LINK-41). Busy answers carry how many went in;
   * the rest is sent again. A refusal throws `WriteError` on the op the radio stopped at.
   */
  private async writeMany(ops: PlanOp[], i: number, run: number, progress: (done: number) => void): Promise<void> {
    let done = 0;
    const end = performance.now() + P.timing.busy_retry_ms;
    while (done < run) {
      const recs = ops.slice(i + done, i + run).map((o) => wholeRecord(o)!);
      const body = new Uint8Array(1 + recs.reduce((n, r) => n + r.entry.length, 0));
      body[0] = recs[0].what;
      let o = 1;
      for (const r of recs) {
        body.set(r.entry, o);
        o += r.entry.length;
      }
      const { status, rest } = await this.askRaw(P.msg.WRITE_MANY, body);
      const applied = rest.length ? rest[0] : 0;
      done += status === 0 ? recs.length : applied;
      progress(i + done);
      if (status === 0) continue;
      if (status === 7 && performance.now() < end) {
        await sleep(P.timing.busy_sleep_ms);
        continue;
      }
      throw new WriteError(ops[i + done], i + done, new RadioError(P.msg.WRITE_MANY, status, rest.slice(1)));
    }
  }

  /**
   * LINK-41.1: the WRITE_MANY frames from ops[i] on (as long as ops go whole), two in flight: the radio takes the
   * next from its receive ring as it answers each, so its store never waits for a round trip. Answers come in
   * order. Anything but `ok` lets what's in flight finish, then goes on one frame at a time from the first op not
   * applied (a `busy` asked again there, a refusal thrown). The index after the last op written.
   */
  private async writeManyWindowed(ops: PlanOp[], i: number, progress: (done: number) => void): Promise<number> {
    const frames: { at: number; run: number; body: Uint8Array }[] = [];
    for (let k = i; ; ) {
      const run = manyRun(ops, k);
      if (run === 0) break;
      const recs = ops.slice(k, k + run).map((o) => wholeRecord(o)!);
      const body = new Uint8Array(1 + recs.reduce((n, r) => n + r.entry.length, 0));
      body[0] = recs[0].what;
      let o = 1;
      for (const r of recs) {
        body.set(r.entry, o);
        o += r.entry.length;
      }
      frames.push({ at: k, run, body });
      k += run;
    }
    const send = (f: (typeof frames)[number]) => {
      const seq = this.session.next_seq();
      const got = new Promise<Answer | null>((resolve) => {
        this.waiters.set(seq, { ty: P.msg.WRITE_MANY, seq, resolve });
        setTimeout(() => resolve(null), this.timeout() * 2);
      });
      void this.t.write(this.session.request(P.msg.WRITE_MANY, f.body, performance.now()));
      debugLog(`link WRITE_MANY #${seq} (windowed) ops ${f.at}-${f.at + f.run - 1}, ${f.body.length} B`);
      return { f, got, seq };
    };
    const flight: ReturnType<typeof send>[] = [];
    let k = 0;
    let stop: { at: number; lost?: boolean } | null = null;
    // After a stop nothing more is sent: only what is in flight drains (frames left unsent go one at a time below).
    while (flight.length || (!stop && k < frames.length)) {
      while (!stop && k < frames.length && flight.length < 2) flight.push(send(frames[k++]));
      const { f, got, seq } = flight.shift()!;
      const a = await got;
      if (this.closed) throw new Error("not connected");
      debugLog(`link WRITE_MANY #${seq} (windowed): ${a ? `status ${a.status}, applied ${a.status === 0 ? f.run : (a.rest[0] ?? 0)}` : "NO ANSWER"}${stop ? " (draining)" : ""}`);
      if (stop) {
        if (!a) this.waiters.delete(seq);
        continue; // after a refusal or a lost frame: only draining what's in flight
      }
      if (!a) {
        // A frame (or its answer) lost: whether it was applied isn't known, but writing a record again changes
        // nothing, so the rest goes one frame at a time from this frame's first op, after a resync (LINK-51: a lost
        // frame leaves the compression windows apart). Before, the write stopped here with 5 channels written.
        this.waiters.delete(seq);
        stop = { at: f.at, lost: true };
        continue;
      }
      const applied = a.status === 0 ? f.run : a.rest.length ? a.rest[0] : 0;
      progress(f.at + applied);
      if (a.status !== 0) stop = { at: f.at + applied };
    }
    if (!stop) return frames.length ? frames[frames.length - 1].at + frames[frames.length - 1].run : i;
    // the rest one frame at a time, from the first op the radio didn't apply (busy asked again, a refusal thrown)
    if (stop.lost) await this.resync();
    let at = stop.at;
    while (at < frames[frames.length - 1].at + frames[frames.length - 1].run) {
      const run = manyRun(ops, at);
      await this.writeMany(ops, at, run, progress);
      at += run;
    }
    return at;
  }

  /**
   * APRS contacts written (APRS-42, record 6): each a callsign (10 bytes), a name (12) and flags (bit 0 deletes),
   * added or renamed by callsign. Nine to a WRITE_MANY frame; `busy` is sent again; a refusal throws with its reason.
   */
  writeContacts(recs: Uint8Array[]): Promise<void> {
    return this.exclusive(async () => {
      this.records();
      for (let i = 0; i < recs.length; ) {
        const part = recs.slice(i, i + 9);
        const body = new Uint8Array(1 + part.length * 26);
        body[0] = 6;
        part.forEach((r, k) => {
          body.set([0xff, 0xff, 23], 1 + k * 26);
          body.set(r, 4 + k * 26);
        });
        const end = performance.now() + P.timing.busy_retry_ms;
        for (;;) {
          const { status, rest } = await this.askRaw(P.msg.WRITE_MANY, body);
          if (status === 0) break;
          if (status === 7 && performance.now() < end) {
            await sleep(P.timing.busy_sleep_ms);
            continue;
          }
          throw new RadioError(P.msg.WRITE_MANY, status, rest.slice(1));
        }
        i += part.length;
      }
    });
  }

  /**
   * LINK-53: channel positions written (`WRITE_MANY` of what 7): each the channel's index (its number minus 1) and
   * its 8-byte record, or 0 bytes to clear it. 21 to a frame (MAX_PAYLOAD 240); `busy` goes again from the first
   * not applied; a refusal throws with the radio's reason. `progress(done)` as frames are answered.
   */
  /**
   * Stops every slot's scan before a write (LINK-67's state, LINK-68's TUNE scan stop): a scanning radio answers the
   * link late (LINK-38), and a write stopped part way through. Waits up to 2 s for the radio to say they stopped.
   * The slots it stopped ("A", "B", "C").
   */
  stopScans(): Promise<string[]> {
    return this.exclusive(async () => {
      const scanning = () => this.scanningRaw();
      const was = await scanning();
      for (const s of was) await this.okRaw(P.msg.TUNE, tunePayload("ABC".indexOf(s.slot), "scan", 0));
      for (const end = performance.now() + 2_000; was.length && (await scanning()).length; ) {
        if (performance.now() > end) throw new Error("the radio is still scanning: stop the scan on the radio, then write again");
        await sleep(100);
      }
      return was.map((s) => s.slot);
    });
  }

  /** The slots scanning now ("A", "B", "C"; LINK-67's state). */
  scanningSlots(): Promise<string[]> {
    return this.exclusive(async () => (await this.scanningRaw()).map((s) => s.slot));
  }

  private async scanningRaw() {
    return (stateParse(await this.okRaw(P.msg.STATE))?.slots ?? []).filter((s) => s.scanning);
  }

  writePositions(recs: { index: number; record: Uint8Array }[], progress?: (done: number) => void): Promise<void> {
    return this.writeRecords(P.what.POSITION, recs, progress);
  }

  /**
   * Records of `what` written by index (`WRITE_MANY`, LINK-41): positions (7), quick messages (8), waypoints (9),
   * DTMF memories (10), skip lists (11). In order, as many to a frame as fit (MAX_PAYLOAD 240): each record waits
   * for the one before it, so an index means the list as the records before it left it (LINK-55). `busy` goes again
   * from the first not applied; a refusal throws with the radio's reason. `progress(done)` as frames are answered.
   */
  writeRecords(what: number, recs: { index: number; record: Uint8Array }[], progress?: (done: number) => void): Promise<void> {
    return this.exclusive(async () => {
      this.records();
      let i = 0;
      let end = performance.now() + P.timing.busy_retry_ms;
      while (i < recs.length) {
        const part: typeof recs = [];
        let size = 1;
        for (let k = i; k < recs.length && size + 3 + recs[k].record.length <= 240; k++) {
          part.push(recs[k]);
          size += 3 + recs[k].record.length;
        }
        const body = new Uint8Array(size);
        body[0] = what;
        let o = 1;
        for (const r of part) {
          body.set([r.index & 0xff, r.index >> 8, r.record.length], o);
          body.set(r.record, o + 3);
          o += 3 + r.record.length;
        }
        const { status, rest } = await this.askRaw(P.msg.WRITE_MANY, body);
        const applied = status === 0 ? part.length : rest.length ? rest[0] : 0;
        i += applied;
        progress?.(i);
        if (status === 0) {
          end = performance.now() + P.timing.busy_retry_ms;
          continue;
        }
        if (status === 7 && performance.now() < end) {
          await sleep(P.timing.busy_sleep_ms);
          continue;
        }
        throw new RadioError(P.msg.WRITE_MANY, status, rest.slice(1));
      }
    });
  }

  /**
   * Every record of `what` held at indexes first..end, several whole records an answer (READ_MANY, LINK-40), as a
   * map index → bytes. `progress(at, got)` with the index it has reached and how many records are in, as each
   * answer arrives (on a streamed read too: Bluetooth's take seconds).
   */
  readMany(what: number, first: number, end: number, progress?: (at: number, got: number) => void): Promise<Map<number, Uint8Array>> {
    return this.exclusive(async () => {
      this.records();
      const out = new Map<number, Uint8Array>();
      let at = first;
      const take = (a: Uint8Array) => {
        const d = new DataView(a.buffer, a.byteOffset, a.byteLength);
        let o = 2;
        while (o + 3 <= a.length) {
          const i = d.getUint16(o, true);
          const n = a[o + 2];
          out.set(i, a.slice(o + 3, o + 3 + n));
          o += 3 + n;
        }
        return d.getUint16(0, true);
      };
      // LINK-50: one request, the answers back to back; after a lost frame, again from the last one that came
      for (let tries = 0; tries < 8 && at < end; tries++) {
        const p = new Uint8Array(5);
        const v = new DataView(p.buffer);
        p[0] = what;
        v.setUint16(1, at, true);
        v.setUint16(3, Math.min(end - at, 0xffff), true);
        let frames: Uint8Array[];
        let whole = true;
        // Each answer is taken as it arrives, so progress moves during the stream, not after it.
        let taken = 0;
        const each = (f: Uint8Array) => {
          at = Math.max(at, take(f));
          taken++;
          progress?.(at, out.size);
        };
        const t0 = performance.now();
        try {
          frames = await this.streamRaw(P.msg.READ_MANY, p, each);
        } catch (e) {
          debugLog(`link READ_MANY what ${what} from ${at}: ${e instanceof StreamGap ? `GAP after ${e.got.length} frames, asked again` : `FAILED: ${(e as Error).message}`}`);
          if (!(e instanceof StreamGap)) throw e;
          [frames, whole] = [e.got, false];
        }
        debugLog(`link READ_MANY what ${what} ${first}-${end - 1}: ${frames.length} frames, ${out.size} records in ${(performance.now() - t0).toFixed(0)} ms${whole ? "" : " (a gap)"}`);
        // Any frames not seen by `each` (none normally) are taken now; the error frame (0xff) is not a record.
        for (const f of frames.slice(taken)) {
          if (f[0] === 0xff) continue;
          at = Math.max(at, take(f));
          progress?.(at, out.size);
        }
        if (whole) return out;
      }
      if (at >= end) return out;
      throw new StreamGap([]);
    });
  }

  /** LINK-46: SUBSCRIBE (mask 0 ends it); `renew` keeps it as it is (a keepalive). The dictionary version. */
  async subscribe(mask: number, renew = false): Promise<number> {
    // LINK-19.5: the Live View with the screen as drawn (every screen then shows whole)
    const texts = (mask & 4) !== 0;
    const rest = await this.ok(P.msg.SUBSCRIBE, subscribePayload(mask, 0, renew, texts));
    return rest[1] ?? 0;
  }

  /** LINK-44: the whole heard list, newest first, paged by index. */
  heard(): Promise<{ count: number; stations: Station[] }> {
    return this.exclusive(async () => {
      const stations: Station[] = [];
      let count = 0;
      for (let tries = 0; tries < 6; tries++) {
        try {
          for (const f of await this.streamRaw(P.msg.HEARD, new Uint8Array([0]))) {
            const h = parseHeard(f);
            if (!h) throw new Error("A HEARD answer didn't parse.");
            count = h.count;
            stations.push(...h.stations);
          }
          return { count, stations };
        } catch (e) {
          if (!(e instanceof StreamGap)) throw e;
          stations.length = 0;
        }
      }
      throw new StreamGap([]);
    });
  }

  /** LINK-44: every message in and out, newest first, paged by index. */
  msgs(): Promise<{ count: number; messages: Message[] }> {
    return this.exclusive(async () => {
      const messages: Message[] = [];
      let count = 0;
      for (let tries = 0; tries < 6; tries++) {
        try {
          for (const f of await this.streamRaw(P.msg.MSGS, new Uint8Array([0, 0]))) {
            const m = parseMsgs(f);
            if (!m) throw new Error("A MSGS answer didn't parse.");
            count = m.count;
            messages.push(...m.messages);
          }
          return { count, messages };
        } catch (e) {
          if (!(e instanceof StreamGap)) throw e;
          messages.length = 0;
        }
      }
      throw new StreamGap([]);
    });
  }

  /**
   * LINK-45: an APRS message queued as the radio's compose queues it; it goes by the radio's own TX rules. True
   * when APRS mode is on (it goes at the next turn), false when it waits for APRS mode.
   */
  async msgSend(to: string, text: string): Promise<boolean> {
    const rest = await this.ok(P.msg.MSG_SEND, msgSendPayload(to, text));
    return rest[0] === 1;
  }

  /**
   * LINK-49 (APRS-13.1): one of ours still being tried stops, kept as cancelled. Firmware from before it answers
   * `unknown type`.
   */
  async msgStop(to: string, text: string): Promise<void> {
    await this.ok(P.msg.MSG_STOP, msgSendPayload(to, text));
  }

  /**
   * LINK-52 (decision 323): one message deleted, named by its direction, station and text as MSGS listed it (the
   * newest that matches goes, as the radio's own Delete message). Firmware from before it answers `unknown type`.
   */
  async msgDelete(inbound: boolean, peer: string, text: string): Promise<void> {
    await this.ok(P.msg.MSG_DELETE, msgDeletePayload(inbound, peer, text));
  }

  /**
   * LINK-42: the event log, newest first, every page (below `before`; 0xFFFFFFFF from the newest). `progress` with
   * the records so far.
   */
  log(progress?: (n: number) => void): Promise<{ next: number; held: number; records: LogRecord[] }> {
    return this.exclusive(async () => {
      const records: LogRecord[] = [];
      let before = 0xffffffff;
      let next = 0;
      let held = 0;
      // LINK-50: newest first, back to back; after a lost frame, again from below the last record that came
      for (let tries = 0; tries < 8; tries++) {
        let frames: Uint8Array[];
        let whole = true;
        try {
          frames = await this.streamRaw(P.msg.LOG_READ, logReadPayload(before));
        } catch (e) {
          if (!(e instanceof StreamGap)) throw e;
          [frames, whole] = [e.got, false];
        }
        for (const f of frames) {
          const p = parseLogPage(f);
          if (!p) throw new Error("A LOG_READ answer didn't parse.");
          if (!records.length && before === 0xffffffff) [next, held] = [p.next, p.held];
          records.push(...p.records);
          if (p.records.length) before = p.records[p.records.length - 1].seq;
        }
        progress?.(records.length);
        if (whole) return { next, held, records };
      }
      throw new StreamGap([]);
    });
  }

  /**
   * A write session (LINK-9): BEGIN with the count, each op's WRITE parts or DELETE in order, then END, whatever
   * happened, all in one `exclusive` so nothing cuts in. Stops at the first refusal, which it throws with the op it
   * was on; `progress(done)` after each op.
   */
  writeSession(begin: Uint8Array, ops: PlanOp[], progress: (done: number) => void): Promise<void> {
    return this.exclusive(async () => {
      this.records();
      await this.okRaw(P.msg.BEGIN, begin);
      try {
        for (let i = 0; i < ops.length; ) {
          // LINK-41: channel and zone writes go as WRITE_MANY, several to a frame; deletes and the settings record
          // (bigger than a frame) as before.
          const dels = deleteRun(ops, i);
          if (dels > 0) {
            // LINK-41.2: channel deletes several to a WRITE_MANY (records of length 0)
            const body = new Uint8Array(1 + dels * 3);
            body[0] = 2;
            for (let k = 0; k < dels; k++) {
              const p = ops[i + k].payloads[0];
              body.set([p[1], p[2], 0], 1 + k * 3);
            }
            // each delete is a flash write on the radio: 79 took black 4.3 s (Nov 16, 2026), past the 2 s a cable
            // request waits, and Console said the radio had stopped answering
            const { status, rest } = await this.askRaw(P.msg.WRITE_MANY, body, deleteWaitMs(this.timeout(), dels));
            if (status !== 0) {
              const done = rest.length ? rest[0] : 0;
              throw new WriteError(ops[i + done], i + done, new RadioError(P.msg.WRITE_MANY, status, rest.slice(1)));
            }
            i += dels;
            progress(i);
            continue;
          }
          const run = manyRun(ops, i);
          if (run > 0) {
            i = await this.writeManyWindowed(ops, i, progress);
            continue;
          }
          const op = ops[i];
          for (const p of op.payloads) {
            try {
              await this.okRaw(op.msg, new Uint8Array(p));
            } catch (e) {
              throw new WriteError(op, i, e as Error);
            }
          }
          i++;
          progress(i);
        }
      } finally {
        try {
          await this.okRaw(P.msg.END);
        } catch {
          /* the session also ends by itself after 5 s */
        }
      }
    });
  }
}

/** How long a frame of `n` channel deletes may take to answer: the request's own wait, and 100 ms a delete (black
 *  took 55 ms each: Nov 16, 2026). */
export function deleteWaitMs(base: number, n: number): number {
  return base + n * 100;
}

/** A WRITE whose record fits one part: [what, index, offset 0, total, bytes] with the whole record in it. */
function wholeRecord(op: PlanOp): { what: number; entry: Uint8Array } | null {
  if (op.kind !== "write" || op.msg !== P.msg.WRITE || op.payloads.length !== 1) return null;
  const p = op.payloads[0];
  const off = p[3] | (p[4] << 8);
  const total = p[5] | (p[6] << 8);
  if ((p[0] !== 2 && p[0] !== 3 && p[0] !== 4) || off !== 0 || total !== p.length - 7 || total > 255) return null;
  return { what: p[0], entry: new Uint8Array([p[1], p[2], total, ...p.slice(7)]) };
}

/** How many ops from `i` go in one WRITE_MANY frame (MAX_PAYLOAD 240: the what byte, then index, length, record). */
function manyRun(ops: PlanOp[], i: number): number {
  if (i >= ops.length) return 0;
  const first = wholeRecord(ops[i]);
  if (!first) return 0;
  let size = 1;
  let n = 0;
  for (let k = i; k < ops.length; k++) {
    const r = wholeRecord(ops[k]);
    if (!r || r.what !== first.what || size + r.entry.length > 240) break;
    size += r.entry.length;
    n++;
  }
  return n;
}

/** LINK-41.2: how many channel deletes from `i` go in one WRITE_MANY (79 of 3 bytes in 240). */
function deleteRun(ops: PlanOp[], i: number): number {
  let n = 0;
  for (let k = i; k < ops.length && n < 79; k++) {
    const o = ops[k];
    if (o.msg !== P.msg.DELETE || o.payloads.length !== 1 || o.payloads[0][0] !== 2) break;
    n++;
  }
  return n;
}

/** A write session stopped at an op: which, how many went before it, and the radio's reason. */
export class WriteError extends Error {
  constructor(
    readonly op: PlanOp,
    readonly done: number,
    readonly reason: Error,
  ) {
    super(`${op.what} ${op.number}: ${reason instanceof RadioError && reason.status === 10 ? "cancelled on the radio (BACK)" : reason.message}`);
  }
}
