CREATE TABLE IF NOT EXISTS sdo_participant (
  participant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  contact TEXT,
  system_description TEXT,
  api_key_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  participant_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_observability_event (
  event_id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  source_participant_id TEXT REFERENCES sdo_participant(participant_id),
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  context JSONB,
  artefacts JSONB,
  failure_category TEXT,
  duration_ms INTEGER,
  metadata_completeness_score DOUBLE PRECISION,
  validation_error_count INTEGER,
  attributes JSONB,
  event_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sdo_participant_status
  ON sdo_participant(status);

CREATE INDEX IF NOT EXISTS idx_semantic_event_timestamp
  ON semantic_observability_event(timestamp);

CREATE INDEX IF NOT EXISTS idx_semantic_event_source_participant
  ON semantic_observability_event(source_participant_id);

CREATE INDEX IF NOT EXISTS idx_semantic_event_type
  ON semantic_observability_event(event_type);

CREATE INDEX IF NOT EXISTS idx_semantic_event_component
  ON semantic_observability_event(component);

CREATE INDEX IF NOT EXISTS idx_semantic_event_status
  ON semantic_observability_event(status);

CREATE INDEX IF NOT EXISTS idx_semantic_event_context_transfer
  ON semantic_observability_event((context->>'transferId'));

CREATE INDEX IF NOT EXISTS idx_semantic_event_context_agreement
  ON semantic_observability_event((context->>'agreementId'));

CREATE INDEX IF NOT EXISTS idx_semantic_event_context_correlation
  ON semantic_observability_event((context->>'correlationId'));

CREATE INDEX IF NOT EXISTS idx_semantic_event_context_dataset
  ON semantic_observability_event((context->>'datasetPseudonym'));

CREATE INDEX IF NOT EXISTS idx_semantic_event_context_pair
  ON semantic_observability_event((context->>'participantPairPseudonym'));
