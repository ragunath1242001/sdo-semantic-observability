export const dimensions = ["adoption", "friction", "evolution", "stability"];

export const metricNames = {
  semanticModelCoverage: "semantic_model_coverage",
  schemaReferenceCoverage: "schema_reference_coverage",
  metadataCompletenessScore: "metadata_completeness_score",
  validationErrorRate: "validation_error_rate",
  policyFailureCount: "policy_failure_count",
  negotiationSuccessRate: "negotiation_success_rate",
  negotiationFailureRate: "negotiation_failure_rate",
  transferSuccessRate: "transfer_success_rate",
  transferFailureRate: "transfer_failure_rate",
  dataPlaneAccessSuccessRate: "data_plane_access_success_rate",
  dataPlaneAccessFailureRate: "data_plane_access_failure_rate",
  averageTransferSetupLatency: "average_transfer_setup_latency",
  artefactVersionAdoptionRate: "artefact_version_adoption_rate",
  deprecatedArtefactUsageRate: "deprecated_artefact_usage_rate"
};

export function buildReport(events, filter = {}) {
  const filtered = filterEvents(events, filter).sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp))
  );
  const now = new Date().toISOString();
  const start = filter.from ?? filtered[0]?.timestamp ?? now;
  const end = filter.to ?? filtered.at(-1)?.timestamp ?? now;

  return {
    generatedAt: now,
    timeWindowStart: start,
    timeWindowEnd: end,
    adoption: adoptionMetrics(filtered, start, end),
    friction: frictionMetrics(filtered, start, end),
    evolution: evolutionMetrics(filtered, start, end),
    stability: stabilityMetrics(filtered, start, end)
  };
}

export function filterEvents(events, filter = {}) {
  const fromMs = filter.from ? Date.parse(filter.from) : undefined;
  const toMs = filter.to ? Date.parse(filter.to) : undefined;

  return events.filter((event) => {
    const eventMs = Date.parse(event.timestamp);
    if (fromMs !== undefined && eventMs < fromMs) return false;
    if (toMs !== undefined && eventMs > toMs) return false;
    if (filter.participantId && event.source?.participantId !== filter.participantId) return false;
    if (filter.component && event.component !== filter.component) return false;
    if (filter.eventType && event.eventType !== filter.eventType) return false;
    if (filter.status && event.status !== filter.status) return false;
    if (filter.datasetPseudonym && event.context?.datasetPseudonym !== filter.datasetPseudonym) return false;
    if (filter.participantPairPseudonym && event.context?.participantPairPseudonym !== filter.participantPairPseudonym) return false;
    if (filter.artefactReference || filter.artefactType || filter.artefactVersion || filter.artefactDeprecated) {
      return event.artefacts?.some((artefact) => {
        if (filter.artefactReference && artefact.reference !== filter.artefactReference) return false;
        if (filter.artefactType && artefact.type !== filter.artefactType) return false;
        if (filter.artefactVersion && artefact.version !== filter.artefactVersion) return false;
        if (filter.artefactDeprecated === "true" && !isDeprecatedArtefact(artefact)) return false;
        if (filter.artefactDeprecated === "false" && isDeprecatedArtefact(artefact)) return false;
        return true;
      }) ?? false;
    }
    return true;
  });
}

export function buildArtefacts(events, filter = {}) {
  const artefacts = new Map();
  for (const event of filterEvents(events, filter)) {
    for (const artefact of event.artefacts ?? []) {
      if (!artefactMatchesFilter(artefact, filter)) continue;
      const key = [artefact.type, artefact.reference, artefact.version ?? ""].join("|");
      const current = artefacts.get(key) ?? {
        type: artefact.type ?? "unknown",
        reference: artefact.reference ?? "unknown",
        version: artefact.version,
        deprecated: isDeprecatedArtefact(artefact),
        eventCount: 0,
        participantIds: new Set(),
        datasetPseudonyms: new Set(),
        firstSeenAt: event.timestamp,
        lastSeenAt: event.timestamp
      };

      current.eventCount += 1;
      current.firstSeenAt = minIso(current.firstSeenAt, event.timestamp);
      current.lastSeenAt = maxIso(current.lastSeenAt, event.timestamp);
      if (event.source?.participantId) current.participantIds.add(event.source.participantId);
      if (event.context?.datasetPseudonym) current.datasetPseudonyms.add(event.context.datasetPseudonym);
      artefacts.set(key, current);
    }
  }

  return [...artefacts.values()]
    .map((artefact) => ({
      ...artefact,
      participantIds: [...artefact.participantIds].sort(),
      datasetPseudonyms: [...artefact.datasetPseudonyms].sort()
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function buildTransactions(events, filter = {}) {
  const groups = new Map();
  for (const event of filterEvents(events, filter)) {
    const key = transactionKey(event);
    const current = groups.get(key) ?? {
      transactionId: key,
      firstSeenAt: event.timestamp,
      lastSeenAt: event.timestamp,
      sourceParticipants: new Set(),
      participantPairPseudonym: event.context?.participantPairPseudonym,
      datasetPseudonym: event.context?.datasetPseudonym,
      status: "info",
      eventCount: 0,
      failureCount: 0,
      warningCount: 0,
      components: new Set(),
      eventTypes: new Set(),
      failureCategories: new Set()
    };

    current.firstSeenAt = minIso(current.firstSeenAt, event.timestamp);
    current.lastSeenAt = maxIso(current.lastSeenAt, event.timestamp);
    current.eventCount += 1;
    current.failureCount += event.status === "failure" ? 1 : 0;
    current.warningCount += event.status === "warning" ? 1 : 0;
    if (event.source?.participantId) current.sourceParticipants.add(event.source.participantId);
    if (event.component) current.components.add(event.component);
    if (event.eventType) current.eventTypes.add(event.eventType);
    if (event.failureCategory) current.failureCategories.add(event.failureCategory);
    if (event.status === "failure") current.status = "failure";
    else if (event.status === "warning" && current.status !== "failure") current.status = "warning";
    else if (event.status === "success" && current.status === "info") current.status = "success";
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sourceParticipants: [...group.sourceParticipants].sort(),
      components: [...group.components].sort(),
      eventTypes: [...group.eventTypes].sort(),
      failureCategories: [...group.failureCategories].sort()
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function buildVersionValidation(events, filter = {}) {
  const validationEvents = filterEvents(events, filter).filter(
    (event) => event.eventType === "metadata.validation.result"
  );
  const totalFailures = failureCount(validationEvents);
  const versions = new Map();

  for (const event of validationEvents) {
    const standardId = scalarString(event.attributes?.governedStandardId);
    const version = scalarString(event.attributes?.governedVersion);
    if (!standardId || !version) continue;

    const key = `${standardId}|${version}`;
    const current = versions.get(key) ?? {
      governedStandardId: standardId,
      version,
      validationCount: 0,
      failureCount: 0,
      failureCategories: new Map(),
      participantIds: new Set()
    };
    current.validationCount += 1;
    if (event.source?.participantId) {
      current.participantIds.add(event.source.participantId);
    }
    if (event.status === "failure") {
      current.failureCount += 1;
      const category = event.failureCategory ?? "validation_failure";
      current.failureCategories.set(
        category,
        (current.failureCategories.get(category) ?? 0) + 1
      );
    }
    versions.set(key, current);
  }

  return [...versions.values()]
    .map((entry) => ({
      governedStandardId: entry.governedStandardId,
      version: entry.version,
      validationCount: entry.validationCount,
      failureCount: entry.failureCount,
      errorRate: rate(entry.failureCount, entry.validationCount),
      failureShare: rate(entry.failureCount, totalFailures),
      participantCount: entry.participantIds.size,
      failureCategories: Object.fromEntries(entry.failureCategories)
    }))
    .sort((a, b) => b.failureCount - a.failureCount || b.validationCount - a.validationCount);
}

export function buildFieldUsage(events, filter = {}, minimumParticipants = 2) {
  const fields = new Map();
  for (const event of filterEvents(events, filter)) {
    if (event.eventType !== "semantic-field.usage.summary") continue;

    const standardId = scalarString(event.attributes?.governedStandardId);
    const version = scalarString(event.attributes?.governedVersion);
    const fieldId = scalarString(event.attributes?.fieldId);
    const observationCount = finiteCount(event.attributes?.observationCount);
    const presentCount = finiteCount(event.attributes?.presentCount);
    if (!standardId || !version || !fieldId || observationCount < 2 || presentCount > observationCount) {
      continue;
    }

    const key = `${standardId}|${version}|${fieldId}`;
    const current = fields.get(key) ?? {
      governedStandardId: standardId,
      version,
      fieldId,
      observationCount: 0,
      presentCount: 0,
      participantIds: new Set(),
      timeWindowStart: scalarString(event.attributes?.timeWindowStart) ?? event.timestamp,
      timeWindowEnd: scalarString(event.attributes?.timeWindowEnd) ?? event.timestamp
    };
    current.observationCount += observationCount;
    current.presentCount += presentCount;
    current.timeWindowStart = minIso(current.timeWindowStart, scalarString(event.attributes?.timeWindowStart) ?? event.timestamp);
    current.timeWindowEnd = maxIso(current.timeWindowEnd, scalarString(event.attributes?.timeWindowEnd) ?? event.timestamp);
    if (event.source?.participantId) {
      current.participantIds.add(event.source.participantId);
    }
    fields.set(key, current);
  }

  return [...fields.values()]
    .filter((entry) => entry.participantIds.size >= minimumParticipants)
    .map((entry) => ({
      governedStandardId: entry.governedStandardId,
      version: entry.version,
      fieldId: entry.fieldId,
      observationCount: entry.observationCount,
      presentCount: entry.presentCount,
      usageRate: rate(entry.presentCount, entry.observationCount),
      participantCount: entry.participantIds.size,
      timeWindowStart: entry.timeWindowStart,
      timeWindowEnd: entry.timeWindowEnd
    }))
    .sort((a, b) => a.usageRate - b.usageRate || b.observationCount - a.observationCount);
}

function adoptionMetrics(events, start, end) {
  const adoption = byDimension(events, "adoption");
  const completeness = adoption
    .map((event) => event.metadataCompletenessScore)
    .filter((score) => typeof score === "number");
  return [
    metric(start, end, metricNames.semanticModelCoverage, artefactCoverage(adoption, ["semantic-model", "base-semantic-model", "ontology", "vocabulary"]), adoption.length),
    metric(start, end, metricNames.schemaReferenceCoverage, artefactCoverage(adoption, ["schema", "openapi-spec"]), adoption.length),
    metric(start, end, metricNames.metadataCompletenessScore, average(completeness), completeness.length)
  ];
}

function frictionMetrics(events, start, end) {
  const validation = byType(events, "metadata.validation.result");
  const policy = byType(events, "policy.evaluation.result");
  const negotiation = byType(events, "negotiation.state.changed");
  const transfer = byType(events, "transfer.state.changed");
  const access = byType(events, "data-plane.access.observed");
  return [
    rateMetric(start, end, metricNames.validationErrorRate, failureCount(validation), validation.length),
    metric(start, end, metricNames.policyFailureCount, failureCount(policy), policy.length, { failureCount: failureCount(policy) }),
    rateMetric(start, end, metricNames.negotiationFailureRate, failureCount(negotiation), negotiation.length),
    rateMetric(start, end, metricNames.transferFailureRate, failureCount(transfer), transfer.length),
    rateMetric(start, end, metricNames.dataPlaneAccessFailureRate, failureCount(access), access.length)
  ];
}

function evolutionMetrics(events, start, end) {
  const artefacts = events.flatMap((event) => event.artefacts ?? []);
  const versioned = artefacts.filter((artefact) => artefact.version);
  const deprecated = artefacts.filter(isDeprecatedArtefact);
  return [
    metric(start, end, metricNames.artefactVersionAdoptionRate, rate(versioned.length, artefacts.length), artefacts.length),
    metric(start, end, metricNames.deprecatedArtefactUsageRate, rate(deprecated.length, artefacts.length), artefacts.length)
  ];
}

function isDeprecatedArtefact(artefact) {
  return artefact.deprecated === true ||
    /deprecated|obsolete|legacy/i.test(String(artefact.status ?? "")) ||
    /deprecated|obsolete|legacy/i.test(String(artefact.lifecycleStatus ?? "")) ||
    /deprecated|obsolete|legacy/i.test(String(artefact.reference ?? ""));
}

function artefactMatchesFilter(artefact, filter = {}) {
  if (filter.artefactReference && artefact.reference !== filter.artefactReference) return false;
  if (filter.artefactType && artefact.type !== filter.artefactType) return false;
  if (filter.artefactVersion && artefact.version !== filter.artefactVersion) return false;
  if (filter.artefactDeprecated === "true" && !isDeprecatedArtefact(artefact)) return false;
  if (filter.artefactDeprecated === "false" && isDeprecatedArtefact(artefact)) return false;
  return true;
}

function stabilityMetrics(events, start, end) {
  const negotiation = byType(events, "negotiation.state.changed");
  const transfer = byType(events, "transfer.state.changed");
  const access = byType(events, "data-plane.access.observed");
  const transferLatencies = transfer
    .map((event) => event.durationMs)
    .filter((duration) => typeof duration === "number");
  return [
    successRateMetric(start, end, metricNames.negotiationSuccessRate, negotiation),
    successRateMetric(start, end, metricNames.transferSuccessRate, transfer, { averageLatencyMs: average(transferLatencies) }),
    metric(start, end, metricNames.averageTransferSetupLatency, average(transferLatencies), transferLatencies.length, { averageLatencyMs: average(transferLatencies) }),
    successRateMetric(start, end, metricNames.dataPlaneAccessSuccessRate, access)
  ];
}

function transactionKey(event) {
  const scope = [
    event.context?.participantPairPseudonym,
    event.context?.datasetPseudonym
  ].filter(Boolean);
  const contextualKey = event.context?.correlationId ??
    event.context?.transferId ??
    event.context?.agreementId ??
    event.context?.negotiationId ??
    (scope.length ? [...scope, hourBucket(event.timestamp)].join("|") : undefined);
  return contextualKey ?? event.eventId;
}

function byDimension(events, dimension) {
  return events.filter((event) => event.dimensions?.includes(dimension));
}

function byType(events, eventType) {
  return events.filter((event) => event.eventType === eventType);
}

function successCount(events) {
  return events.filter((event) => event.status === "success").length;
}

function failureCount(events) {
  return events.filter((event) => event.status === "failure").length;
}

function artefactCoverage(events, artefactTypes) {
  return rate(events.filter((event) =>
    event.artefacts?.some((artefact) => artefactTypes.includes(artefact.type))
  ).length, events.length);
}

function successRateMetric(start, end, name, events, extra = {}) {
  return metric(start, end, name, rate(successCount(events), events.length), events.length, {
    successCount: successCount(events),
    failureCount: failureCount(events),
    ...extra
  });
}

function rateMetric(start, end, name, numerator, denominator) {
  return metric(start, end, name, rate(numerator, denominator), denominator, { failureCount: numerator });
}

function metric(start, end, name, value, count, extra = {}) {
  return {
    timeWindowStart: start,
    timeWindowEnd: end,
    metricName: name,
    metricValue: value,
    count,
    ...extra
  };
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function scalarString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function hourBucket(timestamp) {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function minIso(left, right) {
  return String(left).localeCompare(String(right)) <= 0 ? left : right;
}

function maxIso(left, right) {
  return String(left).localeCompare(String(right)) >= 0 ? left : right;
}
