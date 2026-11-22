/**
 * Await a promise that only an unref'd timer can settle.
 *
 * Main-process code unrefs its timeout timers (and `AbortSignal.timeout` is
 * unref'd by design) because Electron keeps the event loop alive on its own.
 * A fake transport holds no handle either, so on Node 22 the node:test runner
 * sees the loop drain while the test waits and cancels that test and every
 * test after it in the file ("Promise resolution is still pending but the
 * event loop has already resolved"). Node 24's runner keeps the loop alive
 * itself, which is why CI never saw it.
 *
 * The guard timer stands in for the live Electron loop on every supported
 * Node, and turns a timeout path that never fires into a failure instead of a
 * hang.
 */
export async function awaitWithLiveEventLoop(promise, guardMs = 5_000) {
  let guard;
  const expired = new Promise((_resolve, reject) => {
    guard = setTimeout(
      () => reject(new Error(`did not settle within ${guardMs}ms`)),
      guardMs,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(guard);
  }
}
