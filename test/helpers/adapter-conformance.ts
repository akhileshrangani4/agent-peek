// test/helpers/adapter-conformance.ts
import { expect } from "vitest";
import type { Adapter } from "../../src/adapters/types.js";
import type { SessionEntry } from "../../src/core/types.js";
import { decodeCursor } from "../../src/core/cursor.js";

export interface ConformanceFixture {
  name: string;
  entry: SessionEntry;
  expectMinMessages?: number;
  expectEofImmediately?: boolean;
}

export async function runAdapterConformance(adapter: Adapter, fx: ConformanceFixture) {
  const r1 = await adapter.read(fx.entry);
  expect(Array.isArray(r1.messages)).toBe(true);
  if (fx.expectMinMessages !== undefined) {
    expect(r1.messages.length).toBeGreaterThanOrEqual(fx.expectMinMessages);
  }
  const c = decodeCursor(r1.nextCursor);
  expect(c.adapter).toBe(adapter.name);

  const r2 = await adapter.read(fx.entry, r1.nextCursor);
  expect(r2.messages.length).toBe(0);
  expect(decodeCursor(r2.nextCursor).byteOffset).toBe(c.byteOffset);
}
