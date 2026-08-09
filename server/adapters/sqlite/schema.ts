import type { DatabaseSync } from 'node:sqlite'

export function migrateSchema(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN IMMEDIATE')

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)

    const firstMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()
    if (!firstMigration) {
      database.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      mention_name TEXT NOT NULL,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL,
      capability_tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id),
      channel_id TEXT NOT NULL REFERENCES channels(id),
      direct_agent_id TEXT REFERENCES agents(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_retries INTEGER NOT NULL,
      timeout_ms INTEGER NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_label_overrides (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE task_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      runtime_session_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_input_queue (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE task_leases (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      task_id TEXT REFERENCES tasks(id),
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE review_decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX tasks_repository_status_queued_at_idx ON tasks(repository_id, status, queued_at);
    CREATE INDEX task_leases_task_expires_at_idx ON task_leases(task_id, expires_at);
  `)

      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString())
    }

    const secondMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 2').get()
    if (!secondMigration) {
      database.exec(`
        ALTER TABLE agents ADD COLUMN identity TEXT NOT NULL DEFAULT '';
        ALTER TABLE agents ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE agents ADD COLUMN command TEXT NOT NULL DEFAULT '';
        ALTER TABLE agents ADD COLUMN args_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT '';
        ALTER TABLE agents ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}';
        CREATE UNIQUE INDEX agents_workspace_mention_unique_idx ON agents(workspace_id, mention_name);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString())
    }

    const thirdMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 3').get()
    if (!thirdMigration) {
      database.exec(`
        ALTER TABLE repositories ADD COLUMN current_branch TEXT NOT NULL DEFAULT '';
        ALTER TABLE repositories ADD COLUMN default_branch TEXT NOT NULL DEFAULT '';
        ALTER TABLE repositories ADD COLUMN is_clean INTEGER NOT NULL DEFAULT 1;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString())
    }

    const fourthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 4').get()
    if (!fourthMigration) {
      normalizeLegacyDuplicateChannelNames(database)
      database.exec('CREATE UNIQUE INDEX channels_repository_name_unique_idx ON channels(repository_id, name)')
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString())
    }

    const fifthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 5').get()
    if (!fifthMigration) {
      database.exec(`
        CREATE UNIQUE INDEX task_leases_task_unique_idx ON task_leases(task_id);
        CREATE UNIQUE INDEX task_leases_agent_unique_idx ON task_leases(agent_id);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString())
    }

    const sixthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 6').get()
    if (!sixthMigration) {
      database.exec(`
        ALTER TABLE workspaces ADD COLUMN lease_ttl_ms INTEGER NOT NULL DEFAULT 30000 CHECK(lease_ttl_ms > 0);
        ALTER TABLE tasks ADD COLUMN lease_ttl_ms INTEGER CHECK(lease_ttl_ms IS NULL OR lease_ttl_ms > 0);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString())
    }

    const seventhMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 7').get()
    if (!seventhMigration) {
      if (!hasColumn(database, 'channels', 'archived_at')) database.exec('ALTER TABLE channels ADD COLUMN archived_at TEXT')
      archiveLegacyDuplicateChannelNames(database)
      database.exec('CREATE UNIQUE INDEX channels_active_normalized_name_unique_idx ON channels(lower(trim(name))) WHERE archived_at IS NULL')
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString())
    }

    const eighthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 8').get()
    if (!eighthMigration) {
      if (!hasColumn(database, 'messages', 'thread_root_id')) database.exec('ALTER TABLE messages ADD COLUMN thread_root_id TEXT REFERENCES messages(id)')
      database.exec('CREATE INDEX messages_channel_thread_created_idx ON messages(channel_id, thread_root_id, created_at)')
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString())
    }

    const ninthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 9').get()
    if (!ninthMigration) {
      if (!hasColumn(database, 'tasks', 'thread_root_message_id')) database.exec('ALTER TABLE tasks ADD COLUMN thread_root_message_id TEXT REFERENCES messages(id)')
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString())
    }

    const tenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 10').get()
    if (!tenthMigration) {
      database.exec(`
        CREATE TABLE channel_agent_subscriptions (
          channel_id TEXT NOT NULL REFERENCES channels(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          created_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, agent_id)
        );
        CREATE INDEX channel_agent_subscriptions_agent_idx ON channel_agent_subscriptions(agent_id);
      `)
      database.prepare(`
        INSERT OR IGNORE INTO channel_agent_subscriptions (channel_id, agent_id, created_at)
        SELECT channels.id, agents.id, ? FROM channels CROSS JOIN agents WHERE channels.archived_at IS NULL
      `).run(new Date().toISOString())
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString())
    }

    const eleventhMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 11').get()
    if (!eleventhMigration) {
      if (!hasColumn(database, 'agents', 'responsibilities_json')) {
        database.exec("ALTER TABLE agents ADD COLUMN responsibilities_json TEXT NOT NULL DEFAULT '[]'")
      }
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString())
    }

    const twelfthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 12').get()
    if (!twelfthMigration) {
      database.exec('DROP INDEX IF EXISTS channels_repository_name_unique_idx')
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(12, new Date().toISOString())
    }

    const thirteenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 13').get()
    if (!thirteenthMigration) {
      if (!hasColumn(database, 'channels', 'context_reset_at')) database.exec('ALTER TABLE channels ADD COLUMN context_reset_at TEXT')
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(13, new Date().toISOString())
    }

    const fourteenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 14').get()
    if (!fourteenthMigration) {
      database.exec(`
        ALTER TABLE channels ADD COLUMN system_key TEXT;
        ALTER TABLE tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

        CREATE UNIQUE INDEX channels_system_key_unique_idx
          ON channels(system_key) WHERE system_key IS NOT NULL;

        CREATE TABLE channel_agent_memberships (
          channel_id TEXT NOT NULL REFERENCES channels(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          created_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, agent_id)
        );

        CREATE TABLE channel_workspace_bindings (
          channel_id TEXT NOT NULL REFERENCES channels(id),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          created_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, workspace_id)
        );
      `)
      database.prepare(`
        UPDATE channels SET system_key = 'summit'
        WHERE archived_at IS NULL AND lower(trim(name)) = 'summit'
      `).run()
      database.prepare(`
        INSERT INTO channel_agent_memberships (channel_id, agent_id, created_at)
        SELECT channel_id, agent_id, created_at FROM channel_agent_subscriptions
      `).run()
      database.prepare(`
        INSERT INTO channel_workspace_bindings (channel_id, workspace_id, created_at)
        SELECT channels.id, repositories.workspace_id, channels.created_at
        FROM channels JOIN repositories ON repositories.id = channels.repository_id
      `).run()
      database.prepare(`
        UPDATE tasks SET workspace_id = (
          SELECT repositories.workspace_id FROM repositories WHERE repositories.id = tasks.repository_id
        )
      `).run()
      assertNoLegacyGlobalAgentMentionDuplicates(database)
      database.exec(`
        DROP INDEX agents_workspace_mention_unique_idx;
        CREATE UNIQUE INDEX agents_mention_name_unique_idx ON agents(lower(trim(mention_name)));
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(14, new Date().toISOString())
    }

    const fifteenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 15').get()
    if (!fifteenthMigration) {
      database.exec(`
        CREATE TABLE conversation_turns (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          trigger_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
          thread_root_message_id TEXT REFERENCES messages(id),
          mode TEXT NOT NULL CHECK(mode IN ('ordinary', 'direct', 'multi_direct', 'all')),
          status TEXT NOT NULL CHECK(status IN ('screening', 'judging', 'responding', 'handoff', 'completed', 'cancelled', 'failed')),
          current_round INTEGER NOT NULL CHECK(current_round >= 0),
          max_rounds INTEGER NOT NULL CHECK(max_rounds > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE turn_participants (
          id TEXT NOT NULL UNIQUE,
          turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          source TEXT NOT NULL CHECK(source IN ('responsibility', 'direct', 'all', 'handoff')),
          rank INTEGER NOT NULL CHECK(rank >= 0),
          matcher_score REAL,
          decision TEXT NOT NULL CHECK(decision IN ('pending', 'speak', 'silent', 'skipped')),
          confidence REAL,
          proposed_angle TEXT,
          depends_on_agent_id TEXT REFERENCES agents(id),
          speaking_order INTEGER CHECK(speaking_order IS NULL OR speaking_order >= 0),
          status TEXT NOT NULL CHECK(status IN ('candidate', 'selected', 'spoken', 'failed', 'skipped')),
          reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (turn_id, agent_id)
        );

        CREATE TABLE agent_invocations (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          kind TEXT NOT NULL CHECK(kind IN ('participation', 'response', 'duplicate_check', 'handoff_response')),
          priority TEXT NOT NULL CHECK(priority IN ('human_direct', 'human_ordinary', 'participation', 'duplicate_check', 'automatic_handoff')),
          round INTEGER NOT NULL CHECK(round >= 0),
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'settled', 'failed', 'cancelled')),
          idempotency_key TEXT NOT NULL UNIQUE,
          source_invocation_id TEXT REFERENCES agent_invocations(id),
          sequence INTEGER NOT NULL CHECK(sequence >= 0),
          queued_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error_code TEXT
        );

        CREATE TABLE conversation_handoffs (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
          source_invocation_id TEXT NOT NULL REFERENCES agent_invocations(id),
          from_agent_id TEXT NOT NULL REFERENCES agents(id),
          to_agent_id TEXT NOT NULL REFERENCES agents(id),
          question TEXT NOT NULL,
          round INTEGER NOT NULL CHECK(round >= 0),
          status TEXT NOT NULL CHECK(status IN ('queued', 'accepted', 'rejected', 'completed')),
          reason TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE conversation_sessions (
          id TEXT NOT NULL UNIQUE,
          key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          thread_root_message_id TEXT REFERENCES messages(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          runtime TEXT NOT NULL CHECK(runtime IN ('opencode', 'opencode-acp', 'pi', 'claude-code')),
          runtime_session_id TEXT,
          runtime_session_file TEXT,
          status TEXT NOT NULL CHECK(status IN ('ready', 'active', 'stale', 'failed')),
          last_message_id TEXT REFERENCES messages(id),
          last_used_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX conversation_turns_status_created_at_idx
          ON conversation_turns(status, created_at);
        CREATE INDEX agent_invocations_turn_sequence_idx
          ON agent_invocations(turn_id, sequence);
        CREATE INDEX agent_invocations_agent_status_idx
          ON agent_invocations(agent_id, status);
        CREATE UNIQUE INDEX conversation_sessions_grain_unique_idx
          ON conversation_sessions(channel_id, COALESCE(thread_root_message_id, ''), agent_id);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(15, new Date().toISOString())
    }

    const sixteenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 16').get()
    if (!sixteenthMigration) {
      database.exec(`
        ALTER TABLE turn_participants RENAME TO turn_participants_v15;
        CREATE TABLE turn_participants (
          id TEXT NOT NULL UNIQUE,
          turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          source TEXT NOT NULL CHECK(source IN ('responsibility', 'direct', 'all', 'handoff')),
          rank INTEGER NOT NULL CHECK(rank >= 0),
          matcher_score REAL,
          decision TEXT NOT NULL CHECK(decision IN ('pending', 'speak', 'silent', 'skipped')),
          confidence REAL,
          proposed_angle TEXT,
          depends_on_agent_id TEXT REFERENCES agents(id),
          speaking_order INTEGER CHECK(speaking_order IS NULL OR speaking_order >= 0),
          status TEXT NOT NULL CHECK(status IN ('candidate', 'selected', 'spoken', 'failed', 'skipped', 'cancelled')),
          reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (turn_id, agent_id)
        );
        INSERT INTO turn_participants SELECT * FROM turn_participants_v15;
        DROP TABLE turn_participants_v15;

        ALTER TABLE conversation_handoffs RENAME TO conversation_handoffs_v15;
        CREATE TABLE conversation_handoffs (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
          source_invocation_id TEXT NOT NULL REFERENCES agent_invocations(id),
          from_agent_id TEXT NOT NULL REFERENCES agents(id),
          requested_target_agent_id TEXT NOT NULL,
          to_agent_id TEXT REFERENCES agents(id),
          question TEXT NOT NULL,
          round INTEGER NOT NULL CHECK(round >= 0),
          status TEXT NOT NULL CHECK(status IN ('queued', 'accepted', 'rejected', 'completed', 'failed')),
          reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO conversation_handoffs (
          id, turn_id, source_invocation_id, from_agent_id, requested_target_agent_id,
          to_agent_id, question, round, status, reason, created_at, updated_at
        ) SELECT id, turn_id, source_invocation_id, from_agent_id, to_agent_id,
          to_agent_id, question, round, status, reason, created_at, created_at
        FROM conversation_handoffs_v15;
        DROP TABLE conversation_handoffs_v15;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString())
    }

    const seventeenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 17').get()
    if (!seventeenthMigration) {
      database.exec(`
        CREATE TABLE conversation_turns_v17 (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          trigger_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
          thread_root_message_id TEXT REFERENCES messages(id),
          mode TEXT NOT NULL CHECK(mode IN ('ordinary', 'direct', 'multi_direct', 'all')),
          status TEXT NOT NULL CHECK(status IN ('screening', 'judging', 'responding', 'handoff', 'completed', 'partial', 'cancelled', 'failed')),
          current_round INTEGER NOT NULL CHECK(current_round >= 0),
          max_rounds INTEGER NOT NULL CHECK(max_rounds > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO conversation_turns_v17 SELECT * FROM conversation_turns;
        DROP TABLE conversation_turns;
        ALTER TABLE conversation_turns_v17 RENAME TO conversation_turns;
        CREATE INDEX conversation_turns_status_created_at_idx
          ON conversation_turns(status, created_at);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString())
    }

    const eighteenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 18').get()
    if (!eighteenthMigration) {
      database.exec(`
        ALTER TABLE conversation_turns ADD COLUMN recovery_owner_id TEXT;
        ALTER TABLE conversation_turns ADD COLUMN recovery_claimed_at TEXT;
        ALTER TABLE agent_invocations ADD COLUMN result_json TEXT;
        CREATE TABLE conversation_invocation_messages (
          invocation_id TEXT PRIMARY KEY REFERENCES agent_invocations(id),
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX conversation_turns_recovery_claim_idx
          ON conversation_turns(recovery_owner_id, recovery_claimed_at, status);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(18, new Date().toISOString())
    }

    const nineteenthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 19').get()
    if (!nineteenthMigration) {
      database.exec(`
        CREATE TABLE dream_runs (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK(scope = 'channel'),
          scope_id TEXT NOT NULL REFERENCES channels(id),
          trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'manual')),
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
          from_message_created_at TEXT,
          from_message_id TEXT REFERENCES messages(id),
          to_message_created_at TEXT,
          to_message_id TEXT REFERENCES messages(id),
          candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          CHECK((from_message_created_at IS NULL) = (from_message_id IS NULL)),
          CHECK((to_message_created_at IS NULL) = (to_message_id IS NULL))
        );
        CREATE UNIQUE INDEX dream_runs_channel_watermark_unique_idx
          ON dream_runs(scope_id, to_message_created_at, to_message_id);

        CREATE TABLE dream_run_sources (
          dream_run_id TEXT NOT NULL REFERENCES dream_runs(id),
          message_id TEXT NOT NULL REFERENCES messages(id),
          turn_id TEXT REFERENCES conversation_turns(id),
          PRIMARY KEY (dream_run_id, message_id)
        );

        CREATE TABLE memory_candidates (
          id TEXT PRIMARY KEY,
          dream_run_id TEXT NOT NULL REFERENCES dream_runs(id),
          proposed_scope TEXT NOT NULL CHECK(proposed_scope IN ('global', 'channel')),
          channel_id TEXT REFERENCES channels(id),
          kind TEXT NOT NULL CHECK(kind IN ('preference', 'decision', 'constraint', 'fact', 'workflow')),
          proposed_content TEXT NOT NULL,
          rationale TEXT NOT NULL,
          confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
          importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'ignored', 'superseded')),
          reviewed_content TEXT,
          reviewed_scope TEXT CHECK(reviewed_scope IN ('global', 'channel')),
          reviewed_at TEXT,
          created_at TEXT NOT NULL,
          CHECK((proposed_scope = 'global' AND channel_id IS NULL) OR (proposed_scope = 'channel' AND channel_id IS NOT NULL))
        );
        CREATE UNIQUE INDEX memory_candidates_run_content_unique_idx
          ON memory_candidates(dream_run_id, content_hash, proposed_scope, COALESCE(channel_id, ''));

        CREATE TABLE memory_candidate_sources (
          candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
          message_id TEXT NOT NULL REFERENCES messages(id),
          turn_id TEXT REFERENCES conversation_turns(id),
          PRIMARY KEY (candidate_id, message_id)
        );

        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK(scope IN ('global', 'channel')),
          channel_id TEXT REFERENCES channels(id),
          kind TEXT NOT NULL CHECK(kind IN ('preference', 'decision', 'constraint', 'fact', 'workflow')),
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
          source_candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK((scope = 'global' AND channel_id IS NULL) OR (scope = 'channel' AND channel_id IS NOT NULL)),
          CHECK((status = 'active' AND archived_at IS NULL) OR (status = 'archived' AND archived_at IS NOT NULL))
        );
        CREATE UNIQUE INDEX memories_active_content_unique_idx
          ON memories(scope, COALESCE(channel_id, ''), content_hash)
          WHERE archived_at IS NULL;

        CREATE TABLE memory_sources (
          memory_id TEXT NOT NULL REFERENCES memories(id),
          message_id TEXT NOT NULL REFERENCES messages(id),
          turn_id TEXT REFERENCES conversation_turns(id),
          PRIMARY KEY (memory_id, message_id)
        );

        CREATE TABLE thread_summaries (
          channel_id TEXT NOT NULL REFERENCES channels(id),
          thread_root_message_id TEXT NOT NULL REFERENCES messages(id),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, thread_root_message_id)
        );

        CREATE TRIGGER dream_runs_boundary_channel_match
        BEFORE INSERT ON dream_runs
        WHEN (NEW.from_message_id IS NOT NULL AND (SELECT channel_id FROM messages WHERE id = NEW.from_message_id) != NEW.scope_id)
          OR (NEW.to_message_id IS NOT NULL AND (SELECT channel_id FROM messages WHERE id = NEW.to_message_id) != NEW.scope_id)
        BEGIN
          SELECT RAISE(ABORT, 'Dream boundaries must belong to the Dream channel.');
        END;
        CREATE TRIGGER dream_run_sources_channel_match
        BEFORE INSERT ON dream_run_sources
        WHEN (SELECT channel_id FROM messages WHERE id = NEW.message_id)
          != (SELECT scope_id FROM dream_runs WHERE id = NEW.dream_run_id)
        BEGIN
          SELECT RAISE(ABORT, 'Dream source message must belong to the Dream channel.');
        END;
        CREATE TRIGGER memory_candidates_channel_match
        BEFORE INSERT ON memory_candidates
        WHEN NEW.proposed_scope = 'channel' AND NEW.channel_id
          != (SELECT scope_id FROM dream_runs WHERE id = NEW.dream_run_id)
        BEGIN
          SELECT RAISE(ABORT, 'Channel Memory candidate must match the Dream channel.');
        END;
        CREATE TRIGGER memory_candidate_sources_channel_match
        BEFORE INSERT ON memory_candidate_sources
        WHEN (SELECT channel_id FROM messages WHERE id = NEW.message_id)
          != (SELECT scope_id FROM dream_runs JOIN memory_candidates
              ON memory_candidates.dream_run_id = dream_runs.id
              WHERE memory_candidates.id = NEW.candidate_id)
        BEGIN
          SELECT RAISE(ABORT, 'Memory candidate source message must belong to the Dream channel.');
        END;
        CREATE TRIGGER memory_sources_channel_match
        BEFORE INSERT ON memory_sources
        WHEN (SELECT channel_id FROM messages WHERE id = NEW.message_id)
          != (SELECT dream_runs.scope_id
              FROM memories
              JOIN memory_candidates ON memory_candidates.id = memories.source_candidate_id
              JOIN dream_runs ON dream_runs.id = memory_candidates.dream_run_id
              WHERE memories.id = NEW.memory_id)
        BEGIN
          SELECT RAISE(ABORT, 'Memory source message must belong to the Dream channel.');
        END;
        CREATE TRIGGER thread_summaries_channel_match
        BEFORE INSERT ON thread_summaries
        WHEN (SELECT channel_id FROM messages WHERE id = NEW.thread_root_message_id) != NEW.channel_id
        BEGIN
          SELECT RAISE(ABORT, 'Thread summary root message must belong to its channel.');
        END;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(19, new Date().toISOString())
    }

    const twentiethMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 20').get()
    if (!twentiethMigration) {
      database.exec(`
        DROP INDEX dream_runs_channel_watermark_unique_idx;
        CREATE UNIQUE INDEX dream_runs_channel_watermark_unique_idx
          ON dream_runs(scope_id, COALESCE(to_message_created_at, ''), COALESCE(to_message_id, ''));
      `)

      if (!hasColumn(database, 'memory_sources', 'candidate_id')) {
        database.exec(`
          DROP TRIGGER IF EXISTS memory_sources_channel_match;
          DROP TRIGGER IF EXISTS memory_sources_candidate_match;
          CREATE TABLE memory_sources_v20 (
            memory_id TEXT NOT NULL REFERENCES memories(id),
            candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
            message_id TEXT NOT NULL REFERENCES messages(id),
            turn_id TEXT REFERENCES conversation_turns(id),
            PRIMARY KEY (memory_id, candidate_id, message_id)
          );
          INSERT INTO memory_sources_v20 (memory_id, candidate_id, message_id, turn_id)
          SELECT
            legacy.memory_id,
            COALESCE(
              (
                SELECT candidates.id
                FROM memory_candidate_sources
                JOIN memory_candidates AS candidates ON candidates.id = memory_candidate_sources.candidate_id
                JOIN dream_runs ON dream_runs.id = candidates.dream_run_id
                WHERE memory_candidate_sources.candidate_id = memories.source_candidate_id
                  AND memory_candidate_sources.message_id = legacy.message_id
                  AND candidates.status = 'accepted'
                  AND candidates.reviewed_content = memories.content
                  AND candidates.reviewed_scope = memories.scope
                  AND (memories.scope = 'global' OR dream_runs.scope_id = memories.channel_id)
                LIMIT 1
              ),
              (
                SELECT candidates.id
                FROM memory_candidate_sources
                JOIN memory_candidates AS candidates ON candidates.id = memory_candidate_sources.candidate_id
                JOIN dream_runs ON dream_runs.id = candidates.dream_run_id
                WHERE memory_candidate_sources.message_id = legacy.message_id
                  AND candidates.status = 'accepted'
                  AND candidates.reviewed_content = memories.content
                  AND candidates.reviewed_scope = memories.scope
                  AND (memories.scope = 'global' OR dream_runs.scope_id = memories.channel_id)
                ORDER BY candidates.reviewed_at, candidates.id
                LIMIT 1
              ),
              (
                SELECT candidates.id
                FROM memory_candidates AS candidates
                JOIN dream_runs ON dream_runs.id = candidates.dream_run_id
                WHERE candidates.id = memories.source_candidate_id
                  AND candidates.status = 'accepted'
                  AND candidates.reviewed_scope = memories.scope
                  AND (memories.scope = 'global' OR dream_runs.scope_id = memories.channel_id)
                LIMIT 1
              )
            ),
            legacy.message_id,
            legacy.turn_id
          FROM memory_sources AS legacy
          JOIN memories ON memories.id = legacy.memory_id;
          DROP TABLE memory_sources;
          CREATE TABLE memory_sources (
            memory_id TEXT NOT NULL REFERENCES memories(id),
            candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
            message_id TEXT NOT NULL REFERENCES messages(id),
            turn_id TEXT REFERENCES conversation_turns(id),
            PRIMARY KEY (memory_id, candidate_id, message_id)
          );
          INSERT INTO memory_sources (memory_id, candidate_id, message_id, turn_id)
          SELECT memory_id, candidate_id, message_id, turn_id FROM memory_sources_v20;
          DROP TABLE memory_sources_v20;

          CREATE TRIGGER memory_sources_candidate_match
          BEFORE INSERT ON memory_sources
          WHEN NOT EXISTS (
            SELECT 1
            FROM memory_candidate_sources
            JOIN memory_candidates ON memory_candidates.id = memory_candidate_sources.candidate_id
            JOIN dream_runs ON dream_runs.id = memory_candidates.dream_run_id
            JOIN messages ON messages.id = memory_candidate_sources.message_id
            WHERE memory_candidate_sources.candidate_id = NEW.candidate_id
              AND memory_candidate_sources.message_id = NEW.message_id
              AND messages.channel_id = dream_runs.scope_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'Memory source must belong to its candidate and Dream channel.');
          END;
        `)
      }
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(20, new Date().toISOString())
    }

    const twentyFirstMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 21').get()
    if (!twentyFirstMigration) {
      if (!hasColumn(database, 'thread_summaries', 'through_message_created_at')) {
        database.exec('ALTER TABLE thread_summaries ADD COLUMN through_message_created_at TEXT')
      }
      if (!hasColumn(database, 'thread_summaries', 'through_message_id')) {
        database.exec('ALTER TABLE thread_summaries ADD COLUMN through_message_id TEXT REFERENCES messages(id)')
      }
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString())
    }

    const twentySecondMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 22').get()
    if (!twentySecondMigration) {
      database.exec(`
        UPDATE thread_summaries
        SET through_message_created_at = NULL, through_message_id = NULL
        WHERE (through_message_created_at IS NULL AND through_message_id IS NOT NULL)
           OR (through_message_created_at IS NOT NULL AND through_message_id IS NULL);

        CREATE TRIGGER thread_summaries_watermark_pair_insert
        BEFORE INSERT ON thread_summaries
        WHEN (NEW.through_message_created_at IS NULL AND NEW.through_message_id IS NOT NULL)
          OR (NEW.through_message_created_at IS NOT NULL AND NEW.through_message_id IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'Thread Summary watermark columns must both be NULL or both be non-NULL.');
        END;

        CREATE TRIGGER thread_summaries_watermark_pair_update
        BEFORE UPDATE OF through_message_created_at, through_message_id ON thread_summaries
        WHEN (NEW.through_message_created_at IS NULL AND NEW.through_message_id IS NOT NULL)
          OR (NEW.through_message_created_at IS NOT NULL AND NEW.through_message_id IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'Thread Summary watermark columns must both be NULL or both be non-NULL.');
        END;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString())
    }

    const twentyThirdMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 23').get()
    if (!twentyThirdMigration) {
      if (!hasColumn(database, 'memory_candidates', 'reviewed_channel_id')) {
        database.exec('ALTER TABLE memory_candidates ADD COLUMN reviewed_channel_id TEXT REFERENCES channels(id)')
      }
      database.exec(`
        UPDATE memory_candidates
        SET reviewed_channel_id = COALESCE(
          channel_id,
          (SELECT scope_id FROM dream_runs WHERE dream_runs.id = memory_candidates.dream_run_id)
        )
        WHERE status = 'accepted'
          AND reviewed_scope = 'channel'
          AND reviewed_channel_id IS NULL;

        CREATE TRIGGER IF NOT EXISTS memory_candidates_reviewed_channel_scope_insert
        BEFORE INSERT ON memory_candidates
        WHEN (NEW.reviewed_scope = 'global' AND NEW.reviewed_channel_id IS NOT NULL)
          OR (NEW.reviewed_scope = 'channel' AND NEW.reviewed_channel_id IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'Reviewed Channel must match reviewed Memory scope.');
        END;
        CREATE TRIGGER IF NOT EXISTS memory_candidates_reviewed_channel_scope_update
        BEFORE UPDATE OF reviewed_scope, reviewed_channel_id ON memory_candidates
        WHEN (NEW.reviewed_scope = 'global' AND NEW.reviewed_channel_id IS NOT NULL)
          OR (NEW.reviewed_scope = 'channel' AND NEW.reviewed_channel_id IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'Reviewed Channel must match reviewed Memory scope.');
        END;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(23, new Date().toISOString())
    }

    const twentyFourthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 24').get()
    if (!twentyFourthMigration) {
      database.exec(`
        CREATE TABLE dream_recovery_audit (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK(entity_type = 'memory_candidate'),
          entity_id TEXT NOT NULL,
          error TEXT NOT NULL CHECK(error = 'invalid_candidate_sources'),
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX dream_recovery_audit_entity_error_unique_idx
          ON dream_recovery_audit(entity_type, entity_id, error);
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString())
    }

    const twentyFifthMigration = database.prepare('SELECT version FROM schema_migrations WHERE version = 25').get()
    if (!twentyFifthMigration) {
      database.exec(`
        ALTER TABLE conversation_sessions RENAME TO conversation_sessions_v24;
        CREATE TABLE conversation_sessions (
          id TEXT NOT NULL UNIQUE,
          key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          thread_root_message_id TEXT REFERENCES messages(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          runtime TEXT NOT NULL CHECK(runtime IN ('opencode', 'opencode-acp', 'pi', 'claude-code')),
          runtime_session_id TEXT,
          runtime_session_file TEXT,
          status TEXT NOT NULL CHECK(status IN ('ready', 'active', 'stale', 'failed')),
          last_message_id TEXT REFERENCES messages(id),
          last_used_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO conversation_sessions SELECT * FROM conversation_sessions_v24;
        DROP TABLE conversation_sessions_v24;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(25, new Date().toISOString())
    }

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_grain_unique_idx
        ON conversation_sessions(channel_id, COALESCE(thread_root_message_id, ''), agent_id);
    `)

    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length > 0) throw new Error('Schema migration introduced foreign key violations.')
    database.exec('COMMIT')
    database.exec('PRAGMA foreign_keys = ON')
  } catch (error) {
    database.exec('ROLLBACK')
    database.exec('PRAGMA foreign_keys = ON')
    throw error
  }
}

function hasColumn(database: DatabaseSync, table: string, name: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === name)
}

function assertNoLegacyGlobalAgentMentionDuplicates(database: DatabaseSync): void {
  const duplicate = database.prepare(`
    SELECT lower(trim(mention_name)) AS mention_name
    FROM agents
    GROUP BY lower(trim(mention_name))
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get() as { mention_name: string } | undefined
  if (duplicate) {
    throw new Error(`Migration 14 cannot globalize duplicate Agent mention @${duplicate.mention_name}. Resolve the duplicate before retrying.`)
  }
}

function archiveLegacyDuplicateChannelNames(database: DatabaseSync): void {
  const duplicateGroups = database.prepare(`
    SELECT lower(trim(name)) AS normalized_name FROM channels
    GROUP BY lower(trim(name))
    HAVING COUNT(*) > 1
  `).all() as Array<{ normalized_name: string }>
  const listChannels = database.prepare(`
    SELECT id FROM channels
    WHERE lower(trim(name)) = ?
    ORDER BY created_at, id
  `)
  const archiveChannel = database.prepare('UPDATE channels SET archived_at = ? WHERE id = ?')
  const archivedAt = new Date().toISOString()

  for (const group of duplicateGroups) {
    const duplicates = listChannels.all(group.normalized_name) as Array<{ id: string }>
    for (const duplicate of duplicates.slice(1)) archiveChannel.run(archivedAt, duplicate.id)
  }
}

function normalizeLegacyDuplicateChannelNames(database: DatabaseSync): void {
  const duplicateGroups = database.prepare(`
    SELECT repository_id, name FROM channels
    GROUP BY repository_id, name
    HAVING COUNT(*) > 1
  `).all() as Array<{ repository_id: string; name: string }>
  const listChannels = database.prepare(`
    SELECT id FROM channels
    WHERE repository_id = ? AND name = ?
    ORDER BY created_at, id
  `)
  const channelExists = database.prepare('SELECT 1 FROM channels WHERE repository_id = ? AND name = ? LIMIT 1')
  const renameChannel = database.prepare('UPDATE channels SET name = ? WHERE id = ?')

  for (const group of duplicateGroups) {
    const duplicates = listChannels.all(group.repository_id, group.name) as Array<{ id: string }>
    for (let index = 1; index < duplicates.length; index += 1) {
      let suffix = 2
      let candidateName = `${group.name}-${suffix}`
      while (channelExists.get(group.repository_id, candidateName)) {
        suffix += 1
        candidateName = `${group.name}-${suffix}`
      }
      renameChannel.run(candidateName, duplicates[index].id)
    }
  }
}
