// test/app/fixtures.ts
//
// A real Engine over an in-memory adapter and a temp home: the services under test run
// their own rules against the engine they ship with, and only the transcripts are fake.
import { ClaimsStore } from "../../src/core/claims.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import type { Adapter, RawMessage, SessionEntry } from "../../src/core/types.js";
import { AdapterLoader } from "../../src/app/adapters.js";

export interface FakeSession {
  id: string;
  cwd?: string;
  name?: string;
  status?: SessionEntry["status"];
  parentSessionId?: string;
  messages?: RawMessage[];
}

export function fakeAdapter(sessions: readonly FakeSession[], name = "fake"): Adapter {
  return {
    name,
    async scan() {
      return sessions.map((s) => ({
        id: `${name}:${s.id}`,
        adapter: name,
        transcriptPath: `/tmp/${name}-${s.id}`,
        lastSeen: new Date().toISOString(),
        status: s.status ?? "active",
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.name ? { name: s.name } : {}),
        ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
      }));
    },
    async read(entry, cursor) {
      const all = sessions.find((s) => `${name}:${s.id}` === entry.id)?.messages ?? [];
      const from = cursor ? (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { msgIndex: number }).msgIndex : 0;
      return {
        messages: all.slice(from),
        nextCursor: encodeCursor({ adapter: name, byteOffset: 0, msgIndex: all.length }),
        eof: true,
      };
    },
  };
}

export function fixtureEngine(home: string, adapters: readonly Adapter[]): Engine {
  const loader = new AdapterLoader();
  for (const adapter of adapters) loader.register(adapter);
  return new Engine({ registry: new Registry({ home }), loader, claims: new ClaimsStore({ home }) });
}

export function userTurn(text: string): RawMessage {
  return { role: "user", text, raw: {} };
}

export function toolOnlyTurn(): RawMessage {
  return { role: "assistant", toolCalls: [{ name: "Read", input: { path: "x.ts" }, status: "completed" }], raw: {} };
}
