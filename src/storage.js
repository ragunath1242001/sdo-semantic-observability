import { createReadStream } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const schemaUrl = new URL("../migrations/001_init.sql", import.meta.url);

export async function createStores(options = {}) {
  const storageType = options.storageType ?? process.env.STORAGE_TYPE ?? "jsonl";
  if (storageType === "postgres") {
    const databaseUrl =
      options.databaseUrl ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_TYPE=postgres");
    }

    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.POSTGRES_POOL_SIZE ?? 10)
    });
    await initializePostgresSchema(pool);
    return {
      eventStore: new PostgresEventStore(pool),
      participantStore: new PostgresParticipantStore(pool),
      close: () => pool.end()
    };
  }

  return {
    eventStore: new JsonlEventStore(
      new URL("../data/events.jsonl", import.meta.url)
    ),
    participantStore: new JsonlParticipantStore(
      new URL("../data/participants.jsonl", import.meta.url)
    ),
    close: async () => {}
  };
}

export class JsonlEventStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async append(events) {
    await mkdir(new URL(".", this.filePath), { recursive: true });
    const handle = await open(this.filePath, "a");
    try {
      for (const event of events) {
        await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      }
    } finally {
      await handle.close();
    }
  }

  async readAll() {
    const events = [];
    try {
      const lines = createInterface({
        input: createReadStream(this.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        if (!line.trim()) continue;
        events.push(JSON.parse(line));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return events;
  }
}

export class PostgresEventStore {
  constructor(pool) {
    this.pool = pool;
  }

  async append(events) {
    if (events.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `
          INSERT INTO semantic_observability_event (
            event_id,
            timestamp,
            source_participant_id,
            component,
            event_type,
            dimensions,
            status,
            context,
            artefacts,
            failure_category,
            duration_ms,
            metadata_completeness_score,
            validation_error_count,
            attributes,
            event_json
          )
          VALUES (
            $1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10,
            $11, $12, $13, $14::jsonb, $15::jsonb
          )
          ON CONFLICT (event_id) DO UPDATE SET
            timestamp = EXCLUDED.timestamp,
            source_participant_id = EXCLUDED.source_participant_id,
            component = EXCLUDED.component,
            event_type = EXCLUDED.event_type,
            dimensions = EXCLUDED.dimensions,
            status = EXCLUDED.status,
            context = EXCLUDED.context,
            artefacts = EXCLUDED.artefacts,
            failure_category = EXCLUDED.failure_category,
            duration_ms = EXCLUDED.duration_ms,
            metadata_completeness_score = EXCLUDED.metadata_completeness_score,
            validation_error_count = EXCLUDED.validation_error_count,
            attributes = EXCLUDED.attributes,
            event_json = EXCLUDED.event_json
          `,
          [
            event.eventId,
            event.timestamp,
            event.source?.participantId,
            event.component,
            event.eventType,
            JSON.stringify(event.dimensions ?? []),
            event.status,
            JSON.stringify(event.context ?? null),
            JSON.stringify(event.artefacts ?? null),
            event.failureCategory ?? null,
            event.durationMs ?? null,
            event.metadataCompletenessScore ?? null,
            event.validationErrorCount ?? null,
            JSON.stringify(event.attributes ?? null),
            JSON.stringify(event)
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readAll() {
    const result = await this.pool.query(
      `
      SELECT event_json
      FROM semantic_observability_event
      ORDER BY timestamp ASC, event_id ASC
      `
    );
    return result.rows.map((row) => row.event_json);
  }
}

export class PostgresParticipantStore {
  constructor(pool) {
    this.pool = pool;
  }

  async append(participant) {
    await this.upsert(participant);
  }

  async update(participant) {
    await this.upsert(participant);
  }

  async readAll() {
    const result = await this.pool.query(
      `
      SELECT participant_json
      FROM sdo_participant
      ORDER BY created_at ASC, participant_id ASC
      `
    );
    return result.rows.map((row) => row.participant_json);
  }

  async findById(participantId) {
    const result = await this.pool.query(
      `
      SELECT participant_json
      FROM sdo_participant
      WHERE participant_id = $1
      `,
      [participantId]
    );
    return result.rows[0]?.participant_json;
  }

  async upsert(participant) {
    await this.pool.query(
      `
      INSERT INTO sdo_participant (
        participant_id,
        display_name,
        contact,
        system_description,
        api_key_hash,
        status,
        created_at,
        last_seen_at,
        participant_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (participant_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        contact = EXCLUDED.contact,
        system_description = EXCLUDED.system_description,
        api_key_hash = EXCLUDED.api_key_hash,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        last_seen_at = EXCLUDED.last_seen_at,
        participant_json = EXCLUDED.participant_json
      `,
      [
        participant.participantId,
        participant.displayName,
        participant.contact ?? null,
        participant.systemDescription ?? null,
        participant.apiKeyHash,
        participant.status,
        participant.createdAt,
        participant.lastSeenAt ?? null,
        JSON.stringify(participant)
      ]
    );
  }
}

async function initializePostgresSchema(pool) {
  const schema = await readFile(fileURLToPath(schemaUrl), "utf8");
  await pool.query(schema);
}

export class JsonlParticipantStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async append(participant) {
    await mkdir(new URL(".", this.filePath), { recursive: true });
    const handle = await open(this.filePath, "a");
    try {
      await handle.appendFile(`${JSON.stringify(participant)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  async update(participant) {
    const participants = await this.readAll();
    const updated = participants.map((entry) =>
      entry.participantId === participant.participantId ? participant : entry
    );
    await mkdir(new URL(".", this.filePath), { recursive: true });
    const handle = await open(this.filePath, "w");
    try {
      for (const entry of updated) {
        await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
      }
    } finally {
      await handle.close();
    }
  }

  async readAll() {
    const participants = [];
    try {
      const lines = createInterface({
        input: createReadStream(this.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        if (!line.trim()) continue;
        participants.push(JSON.parse(line));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return participants;
  }

  async findById(participantId) {
    const participants = await this.readAll();
    return participants.find((entry) => entry.participantId === participantId);
  }
}
