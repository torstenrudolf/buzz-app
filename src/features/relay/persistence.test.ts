import { afterEach, expect, it, vi } from "vitest";
import { createHeadPersistence } from "./persistence";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function transaction(abort: () => void) {
  const tx = {
    abort: vi.fn(abort),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => ({ delete: vi.fn() }),
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const cache = createHeadPersistence("viewer", "relay");
  const result = cache.remove("channel");
  request.onsuccess();
  return { tx, result };
}

it("waits for completion when a timeout races an already-finished transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => {
    throw new DOMException("The transaction has finished", "InvalidStateError");
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("still aborts and rejects a genuinely stalled transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => tx.onabort());
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects unexpected abort errors instead of leaving the operation pending", async () => {
  vi.useFakeTimers();
  const failure = new Error("Unexpected abort failure");
  const { result } = transaction(() => {
    throw failure;
  });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});
