// src/lib/transport/webserial.ts: writes on the cable. Link sends two WRITE_MANY frames back to back (LINK-41.1);
// the second write found the stream locked by the first and was never sent, so every windowed write lost a frame
// (a user's log, Nov 17, 2026: "Cannot create writer when WritableStream is locked", then "STOPPED after 5 of 494").
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSerialTransport } from "../../src/lib/transport/webserial.ts";

/** A port whose writes each take a moment to go out (as a real cable's do), recording what was sent. */
function slowPort(sent: number[][]) {
  return {
    async open() {},
    async close() {},
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => new Promise<void>((done) => setTimeout(() => (sent.push([...chunk]), done()), 5)),
    }),
    getInfo: () => ({}),
    addEventListener() {},
  };
}

// fromPort is private: the test opens the transport on its fake port the way request() does after the chooser.
const open = (port: ReturnType<typeof slowPort>): Promise<WebSerialTransport> =>
  (WebSerialTransport as unknown as { fromPort(p: unknown): Promise<WebSerialTransport> }).fromPort(port);

test("regression: two writes back to back both go out, in order", async () => {
  const sent: number[][] = [];
  const t = await open(slowPort(sent));

  await Promise.all([t.write(new Uint8Array([1, 2])), t.write(new Uint8Array([3, 4]))]);

  assert.deepEqual(sent, [[1, 2], [3, 4]]);
});

test("a failed write doesn't stop the writes after it", async () => {
  const sent: number[][] = [];
  const port = slowPort(sent);
  let fail = true;
  port.writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("cable hiccup"));
      }
      sent.push([...chunk]);
    },
  });
  const t = await open(port);

  await assert.rejects(t.write(new Uint8Array([1])), /cable hiccup/);
  // An errored WritableStream refuses every later write: a fresh one stands in for the port's next stream.
  port.writable = new WritableStream<Uint8Array>({ write: (chunk) => void sent.push([...chunk]) });
  await t.write(new Uint8Array([2]));

  assert.deepEqual(sent, [[2]]);
});
