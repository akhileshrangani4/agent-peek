-- OpenCode V2 storage: the two tables and columns the `opencode` adapter reads from
-- opencode.db, with one session per execution outcome the adapter reports.
--   ses_top          idle, outcome failed       (parent of ses_child)
--   ses_child        idle, outcome succeeded    (subagent of ses_top)
--   ses_interrupted  idle, outcome interrupted
--   ses_running      a user message after its last idle: state running
--   ses_shared       also present in legacy filesystem storage; this V2 copy must win
CREATE TABLE session_v2 (
  id text PRIMARY KEY,
  parent_id text,
  title text,
  directory text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
CREATE TABLE session_message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  seq integer NOT NULL,
  time_created integer NOT NULL,
  data text NOT NULL
);
INSERT INTO session_v2 VALUES
  ('ses_top', NULL, 'Provider Retry', '/tmp/repo', 1770000000000, 1770000004000),
  ('ses_child', 'ses_top', 'Child', '/tmp/repo', 1770000000100, 1770000001100),
  ('ses_interrupted', NULL, 'Stopped Early', '/tmp/repo', 1770000010000, 1770000012000),
  ('ses_running', NULL, 'Still Going', '/tmp/repo2', 1770000020000, 1770000023000),
  ('ses_shared', NULL, 'Migrated Session V2', '/tmp/repo', 1769990000000, 1770000030000);
INSERT INTO session_message VALUES
  ('msg_1', 'ses_top', 'user', 1, 1770000000000, '{"time":{"created":1770000000000},"text":"continue the task"}'),
  ('msg_2', 'ses_top', 'assistant', 2, 1770000001000, '{"time":{"created":1770000001000},"content":[{"type":"text","text":"working"},{"type":"tool","name":"shell","state":{"status":"error","error":"upstream failed"}}]}'),
  ('msg_3', 'ses_top', 'compaction', 3, 1770000002000, '{"time":{"created":1770000002000},"error":{"type":"provider.quota","message":"HTTP 503"}}'),
  ('msg_4', 'ses_top', 'idle', 4, 1770000004000, '{"time":{"created":1770000004000},"outcome":"failed"}'),
  ('msg_c1', 'ses_child', 'idle', 1, 1770000001100, '{"time":{"created":1770000001100},"outcome":"succeeded"}'),
  ('msg_i1', 'ses_interrupted', 'user', 1, 1770000010000, '{"time":{"created":1770000010000},"text":"refactor the parser"}'),
  ('msg_i2', 'ses_interrupted', 'idle', 2, 1770000012000, '{"time":{"created":1770000012000},"outcome":"interrupted"}'),
  ('msg_r1', 'ses_running', 'user', 1, 1770000020000, '{"time":{"created":1770000020000},"text":"first turn"}'),
  ('msg_r2', 'ses_running', 'idle', 2, 1770000021000, '{"time":{"created":1770000021000},"outcome":"succeeded"}'),
  ('msg_r3', 'ses_running', 'user', 3, 1770000023000, '{"time":{"created":1770000023000},"text":"second turn"}'),
  ('msg_s1', 'ses_shared', 'user', 1, 1769990000000, '{"time":{"created":1769990000000},"text":"V2 copy of the shared session"}'),
  ('msg_s2', 'ses_shared', 'idle', 2, 1770000030000, '{"time":{"created":1770000030000},"outcome":"succeeded"}');
