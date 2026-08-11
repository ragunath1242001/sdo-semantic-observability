import { createHash, randomBytes } from "node:crypto";

export function createParticipantRegistration(input, publicBaseUrl) {
  const participantId = `participant_${randomBytes(6).toString("hex")}`;
  const apiKey = `sdo_pk_${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();

  return {
    participant: {
      participantId,
      displayName: sanitizeText(input.displayName) ?? participantId,
      contact: sanitizeText(input.contact),
      systemDescription: sanitizeText(input.systemDescription),
      apiKeyHash: hashApiKey(apiKey),
      createdAt: now,
      lastSeenAt: undefined,
      status: "active"
    },
    response: {
      participantId,
      apiKey,
      endpoint: `${publicBaseUrl.replace(/\/$/, "")}/api/ingest/events`
    }
  };
}

export function publicParticipant(participant, eventSummary) {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    contact: participant.contact,
    systemDescription: participant.systemDescription,
    createdAt: participant.createdAt,
    lastSeenAt: participant.lastSeenAt,
    status: participant.status,
    eventCount: eventSummary?.eventCount ?? 0,
    failureCount: eventSummary?.failureCount ?? 0,
    latestEventAt: eventSummary?.latestEventAt
  };
}

export function summarizeParticipantEvents(events) {
  const summaries = new Map();
  for (const event of events) {
    const participantId = event.source?.participantId;
    if (!participantId) continue;
    const current = summaries.get(participantId) ?? {
      eventCount: 0,
      failureCount: 0,
      latestEventAt: undefined
    };
    current.eventCount += 1;
    current.failureCount += event.status === "failure" ? 1 : 0;
    current.latestEventAt = maxIso(current.latestEventAt, event.timestamp);
    summaries.set(participantId, current);
  }
  return summaries;
}

export function apiKeyMatches(apiKey, apiKeyHash) {
  return Boolean(apiKey && apiKeyHash && hashApiKey(apiKey) === apiKeyHash);
}

export function hashApiKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function sanitizeText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed.slice(0, 200) : undefined;
}

function maxIso(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left).localeCompare(String(right)) >= 0 ? left : right;
}
