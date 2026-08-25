import type { Cursor, CursorData } from "./types.js";
import { CursorMismatchError, InvalidCursorError } from "./errors.js";

export function encodeCursor(data: CursorData): Cursor {
  const json = JSON.stringify(data);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: Cursor, expectedAdapter?: string): CursorData {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  let data: CursorData;
  try {
    data = JSON.parse(json);
  } catch {
    throw new InvalidCursorError("not JSON");
  }
  if (typeof data !== "object" || data === null || typeof data.adapter !== "string"
      || !Number.isInteger(data.byteOffset) || data.byteOffset < 0
      || !Number.isInteger(data.msgIndex) || data.msgIndex < 0) {
    throw new InvalidCursorError("bad shape");
  }
  if (data.tail !== undefined && typeof data.tail !== "string") {
    throw new InvalidCursorError("bad shape");
  }
  if (expectedAdapter && data.adapter !== expectedAdapter) {
    throw new CursorMismatchError(data.adapter, expectedAdapter);
  }
  return data;
}

export function cursorAdapter(cursor: Cursor): string {
  return decodeCursor(cursor).adapter;
}
