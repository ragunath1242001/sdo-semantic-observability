import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  apiKeyMatches,
  createParticipantRegistration,
  publicParticipant,
  summarizeParticipantEvents
} from "./participants.js";
import {
  buildArtefacts,
  buildFieldUsage,
  buildReport,
  buildTransactions,
  buildVersionValidation,
  filterEvents
} from "./semantic.js";
import { createStores } from "./storage.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT ?? 4100);
const publicBaseUrl = process.env.SDO_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const storageType = process.env.STORAGE_TYPE ?? "jsonl";
const maxBatchSize = 1000;
const maxBodyBytes = 5_000_000;
const fieldUsageMinimumParticipants = Math.max(
  2,
  Number(process.env.SDO_FIELD_USAGE_MIN_PARTICIPANTS) || 2
);
const { eventStore: store, participantStore, close } = await createStores({
  storageType
});
const eventStreamClients = new Set();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        status: "ok",
        service: "sdo-semantic-observability",
        storage: storageType
      });
    }

    if (request.method === "GET" && url.pathname === "/api/events/stream") {
      return streamEvents(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/participants/register") {
      const body = await readJson(request);
      const registration = createParticipantRegistration(body, publicBaseUrl);
      await participantStore.append(registration.participant);
      return json(response, 201, registration.response);
    }

    if (request.method === "GET" && url.pathname === "/api/participants") {
      const [participants, events] = await Promise.all([
        participantStore.readAll(),
        store.readAll()
      ]);
      const eventSummaries = summarizeParticipantEvents(events);
      return json(response, 200, {
        data: participants.map((participant) =>
          publicParticipant(participant, eventSummaries.get(participant.participantId))
        ),
        total: participants.length
      });
    }

    if (request.method === "GET" && url.pathname === "/api/participants/me") {
      const participant = await requireParticipant(request);
      const eventSummaries = summarizeParticipantEvents(await store.readAll());
      return json(
        response,
        200,
        publicParticipant(participant, eventSummaries.get(participant.participantId))
      );
    }

    if (request.method === "POST" && url.pathname === "/api/ingest/events") {
      const participant = await requireParticipant(request);
      const body = await readJson(request);
      const accepted = normalizeIngestedEvents(body, participant);
      await store.append(accepted);
      await participantStore.update({
        ...participant,
        lastSeenAt: new Date().toISOString()
      });
      broadcastEventUpdate(accepted);
      return json(response, 202, { accepted: accepted.length });
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const events = await store.readAll();
      const filtered = filterEvents(events, queryFilter(url)).sort((a, b) =>
        String(b.timestamp).localeCompare(String(a.timestamp))
      );
      const take = Math.min(Number(url.searchParams.get("take") ?? 100), 500);
      return json(response, 200, {
        data: filtered.slice(0, take),
        total: filtered.length
      });
    }

    if (request.method === "GET" && url.pathname === "/api/report") {
      const events = await store.readAll();
      return json(response, 200, buildReport(events, queryFilter(url)));
    }

    if (request.method === "GET" && url.pathname === "/api/artefacts") {
      const events = await store.readAll();
      const artefacts = buildArtefacts(events, queryFilter(url));
      return json(response, 200, {
        data: artefacts,
        total: artefacts.length
      });
    }

    if (request.method === "GET" && url.pathname === "/api/transactions") {
      const events = await store.readAll();
      return json(response, 200, {
        data: buildTransactions(events, queryFilter(url)),
        total: buildTransactions(events, queryFilter(url)).length
      });
    }

    if (request.method === "GET" && url.pathname === "/api/version-validation") {
      const events = await store.readAll();
      const data = buildVersionValidation(events, queryFilter(url));
      return json(response, 200, { data, total: data.length });
    }

    if (request.method === "GET" && url.pathname === "/api/field-usage") {
      const events = await store.readAll();
      const data = buildFieldUsage(
        events,
        queryFilter(url),
        fieldUsageMinimumParticipants
      );
      return json(response, 200, { data, total: data.length });
    }

    if (request.method === "GET") {
      return serveStatic(url.pathname, response);
    }

    return json(response, 404, { error: "not_found" });
  } catch (error) {
    const status = error.statusCode ?? 500;
    return json(response, status, {
      error: status === 500 ? "internal_server_error" : error.message
    });
  }
});

server.listen(port, () => {
  console.log(`SDO semantic observability listening on http://localhost:${port}`);
  console.log(`SDO semantic observability storage: ${storageType}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close(async () => {
      await close();
      process.exit(0);
    });
  });
}

function normalizeIngestedEvents(body, participant) {
  const events = Array.isArray(body) ? body : body?.events;
  if (!Array.isArray(events)) {
    throw httpError(400, "Expected an event array or an object with events");
  }
  if (events.length > maxBatchSize) {
    throw httpError(413, `A batch may contain at most ${maxBatchSize} events`);
  }

  return events.map((event) => {
    validateIngestedEvent(event);

    return {
      eventId: event.eventId ?? event.id ?? `sdo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
      component: event.component,
      eventType: event.eventType,
      dimensions: Array.isArray(event.dimensions) ? event.dimensions : [],
      status: event.status,
      context: sanitizedContext(event.context),
      artefacts: event.artefacts?.map((artefact) => ({
        type: artefact.type,
        reference: artefact.reference,
        version: artefact.version
      })),
      failureCategory: event.failureCategory,
      durationMs: event.durationMs,
      metadataCompletenessScore: event.metadataCompletenessScore,
      validationErrorCount: event.validationErrorCount,
      attributes: sanitizedAttributes(event.attributes),
      source: {
        participantId: participant.participantId,
        receivedAt: new Date().toISOString()
      }
    };
  });
}

function validateIngestedEvent(event) {
  if (!isObject(event)) throw httpError(400, "Each event must be a JSON object");
  if (event.eventId !== undefined && !boundedString(event.eventId, 256)) {
    throw httpError(400, "eventId must be a string of at most 256 characters");
  }
  if (!boundedString(event.eventType, 128) || !boundedString(event.component, 64)) {
    throw httpError(400, "Each event requires string component and eventType values");
  }
  if (!["info", "success", "failure", "warning"].includes(event.status)) {
    throw httpError(400, "status must be info, success, failure, or warning");
  }
  if (event.timestamp !== undefined &&
      (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)))) {
    throw httpError(400, "timestamp must be a valid ISO date string");
  }
  if (event.dimensions !== undefined &&
      (!Array.isArray(event.dimensions) || event.dimensions.length > 8 ||
      event.dimensions.some((dimension) => !boundedString(dimension, 32)))) {
    throw httpError(400, "dimensions must be an array of short strings");
  }
  if (event.context !== undefined) validateObjectValues(event.context, "context", 32, 256);
  if (event.artefacts !== undefined) {
    if (!Array.isArray(event.artefacts) || event.artefacts.length > 32) {
      throw httpError(400, "artefacts must contain at most 32 entries");
    }
    event.artefacts.forEach((artefact) => {
      if (!isObject(artefact) || !boundedString(artefact.type, 64) ||
          !boundedString(artefact.reference, 512) ||
          !artefact.reference.startsWith("p_") ||
          (artefact.version !== undefined && !boundedString(artefact.version, 64))) {
        throw httpError(400, "Each artefact requires a type and pseudonymized reference");
      }
    });
  }
  if (event.attributes !== undefined) {
    if (!isObject(event.attributes) || Object.keys(event.attributes).length > 50) {
      throw httpError(400, "attributes must be an object with at most 50 entries");
    }
    for (const [key, value] of Object.entries(event.attributes)) {
      if (!boundedString(key, 64) ||
          !(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") ||
          (typeof value === "string" && value.length > 512) ||
          (typeof value === "number" && !Number.isFinite(value))) {
        throw httpError(400, "attributes must contain only bounded scalar values");
      }
    }
  }
  for (const [name, valid] of [
    ["durationMs", Number.isFinite(event.durationMs) && event.durationMs >= 0],
    ["metadataCompletenessScore", Number.isFinite(event.metadataCompletenessScore) && event.metadataCompletenessScore >= 0 && event.metadataCompletenessScore <= 1],
    ["validationErrorCount", Number.isInteger(event.validationErrorCount) && event.validationErrorCount >= 0]
  ]) {
    if (event[name] !== undefined && !valid) throw httpError(400, `${name} is out of range`);
  }
  if (event.eventType === "semantic-field.usage.summary") {
    validateFieldUsageSummary(event.attributes);
  }
}

const allowedContextKeys = new Set([
  "participantPseudonym",
  "remoteParticipantPseudonym",
  "participantPairPseudonym",
  "datasetPseudonym",
  "datasetCategory",
  "negotiationId",
  "agreementId",
  "transferId",
  "correlationId",
  "traceId"
]);

const allowedAttributeKeys = new Set([
  "action",
  "datasetVersion",
  "distributionCount",
  "policyCount",
  "datasetType",
  "validateExtraProps",
  "versionCount",
  "currentVersion",
  "mediaType",
  "version",
  "hasPolicy",
  "validationLevel",
  "governedStandardId",
  "governedVersion",
  "fieldId",
  "timeWindowStart",
  "timeWindowEnd",
  "observationCount",
  "presentCount",
  "decision",
  "role",
  "scope",
  "state",
  "direction",
  "format",
  "method",
  "httpStatus"
]);

function sanitizedContext(context) {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).filter(([key, value]) =>
      allowedContextKeys.has(key) &&
      (key === "datasetCategory" || String(value).startsWith("p_"))
    )
  );
}

function sanitizedAttributes(attributes) {
  if (!attributes) return undefined;
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => allowedAttributeKeys.has(key))
  );
}

function validateFieldUsageSummary(attributes) {
  if (!isObject(attributes) ||
      !boundedString(attributes.governedStandardId, 512) ||
      !boundedString(attributes.governedVersion, 64) ||
      !boundedString(attributes.fieldId, 512) ||
      !boundedString(attributes.timeWindowStart, 64) ||
      !Number.isFinite(Date.parse(attributes.timeWindowStart)) ||
      !boundedString(attributes.timeWindowEnd, 64) ||
      !Number.isFinite(Date.parse(attributes.timeWindowEnd)) ||
      !Number.isInteger(attributes.observationCount) ||
      attributes.observationCount < 2 ||
      !Number.isInteger(attributes.presentCount) ||
      attributes.presentCount < 0 ||
      attributes.presentCount > attributes.observationCount) {
    throw httpError(400, "Invalid privacy-safe field usage summary");
  }
}

function validateObjectValues(value, name, maxEntries, maxLength) {
  if (!isObject(value) || Object.keys(value).length > maxEntries) {
    throw httpError(400, `${name} must be a bounded object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!boundedString(key, 64) || !boundedString(entry, maxLength)) {
      throw httpError(400, `${name} must contain only bounded string values`);
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function queryFilter(url) {
  const filter = {};
  for (const key of [
    "from",
    "to",
    "participantId",
    "component",
    "eventType",
    "status",
    "datasetPseudonym",
    "participantPairPseudonym",
    "artefactType",
    "artefactReference",
    "artefactVersion",
    "artefactDeprecated"
  ]) {
    const value = url.searchParams.get(key);
    if (value) filter[key] = value;
  }
  return filter;
}

async function requireParticipant(request) {
  const participantId = request.headers["x-sdo-participant-id"];
  const suppliedApiKey =
    request.headers["x-sdo-api-key"] ??
    request.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!participantId || !suppliedApiKey) {
    throw httpError(401, "Missing SDO participant credentials");
  }

  const participant = await participantStore.findById(String(participantId));
  if (
    !participant ||
    participant.status !== "active" ||
    !apiKeyMatches(String(suppliedApiKey), participant.apiKeyHash)
  ) {
    throw httpError(401, "Invalid SDO participant credentials");
  }
  return participant;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!pathToFileURL(filePath).href.startsWith(pathToFileURL(publicDir).href)) {
    return json(response, 403, { error: "forbidden" });
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath) });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(response, 404, { error: "not_found" });
    }
    throw error;
  }
}

function streamEvents(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write("event: connected\n");
  response.write(`data: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);

  eventStreamClients.add(response);
  request.on("close", () => {
    eventStreamClients.delete(response);
  });
}

function broadcastEventUpdate(events) {
  const payload = JSON.stringify({
    receivedAt: new Date().toISOString(),
    accepted: events.length
  });

  for (const client of eventStreamClients) {
    client.write("event: semantic-events\n");
    client.write(`data: ${payload}\n\n`);
  }
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
