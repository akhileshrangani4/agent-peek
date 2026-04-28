import type { Cursor, CursorData } from "./types.js";
import { CursorMismatchError } from "./errors.js";

export function encodeCursor(data: CursorData): Cursor {
  const json = JSON.stringify(data);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: Cursor, expectedAdapter?: string): CursorData {
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error(`Invalid cursor: not base64url`);
  }
  let data: CursorData;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`Invalid cursor: not JSON`);
  }
  if (typeof data !== "object" || data === null || typeof data.adapter !== "string"
      || typeof data.byteOffset !== "number" || typeof data.msgIndex !== "number") {
    throw new Error(`Invalid cursor: bad shape`);
  }
  if (expectedAdapter && data.adapter !== expectedAdapter) {
    throw new CursorMismatchError(data.adapter, expectedAdapter);
  }
  return data;
}

export function cursorAdapter(cursor: Cursor): string {
  return decodeCursor(cursor).adapter;
}
