import type { DatabaseSync } from 'node:sqlite'

export function migrateSchema(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON')
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

    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
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
