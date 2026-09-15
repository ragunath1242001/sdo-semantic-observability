import assert from "node:assert/strict";
import test from "node:test";

import { renameParticipant } from "../src/participants.js";

import {
  buildArtefacts,
  buildBusinessMessageUsage,
  buildFieldUsage,
  buildReport,
  buildVersionValidation
} from "../src/semantic.js";

function event(overrides) {
  return {
    eventId: crypto.randomUUID(),
    timestamp: "2026-08-11T10:00:00.000Z",
    component: "http-data-plane",
    dimensions: ["adoption"],
    status: "info",
    source: { participantId: "participant-a" },
    ...overrides
  };
}

test("renames a participant without changing its identity", () => {
  const participant = { participantId: "participant-a", displayName: "Alfa", status: "active" };
  assert.deepEqual(
    renameParticipant(participant, { displayName: "  AsterFlex Staffing B.V. - SETU staffing supplier  " }),
    { ...participant, displayName: "AsterFlex Staffing B.V. - SETU staffing supplier" }
  );
  assert.equal(renameParticipant(participant, { displayName: " " }), undefined);
});

test("keeps controlled public artefact labels and lifecycle status", () => {
  const rows = buildArtefacts([event({
    eventType: "catalog.dataset.observed",
    artefacts: [{
      type: "schema",
      reference: "p_public_setu_humanresource_v1_4_schema",
      displayName: "SETU HumanResource XML Schema (legacy)",
      version: "1.4",
      deprecated: true,
      lifecycleStatus: "deprecated"
    }]
  })]);

  assert.equal(rows[0].displayName, "SETU HumanResource XML Schema (legacy)");
  assert.equal(rows[0].deprecated, true);
});

test("correlates validation failures with governed versions without claiming causation", () => {
  const events = [
    ...Array.from({ length: 3 }, () => event({
      eventType: "metadata.validation.result",
      status: "failure",
      failureCategory: "missing_required_field",
      attributes: { governedStandardId: "setu:employment", governedVersion: "2.1" }
    })),
    event({
      eventType: "metadata.validation.result",
      status: "success",
      attributes: { governedStandardId: "setu:employment", governedVersion: "2.1" }
    }),
    event({
      eventType: "metadata.validation.result",
      status: "failure",
      attributes: { governedStandardId: "setu:employment", governedVersion: "2.0" }
    })
  ];

  const rows = buildVersionValidation(events);
  assert.deepEqual(rows[0], {
    governedStandardId: "setu:employment",
    version: "2.1",
    validationCount: 4,
    failureCount: 3,
    errorRate: 0.75,
    failureShare: 0.75,
    participantCount: 1,
    failureCategories: { missing_required_field: 3 }
  });
});

test("aggregates only thresholded field-presence counts from multiple participants", () => {
  const summary = (participantId, fieldId, presentCount) => event({
    eventType: "semantic-field.usage.summary",
    source: { participantId },
    attributes: {
      governedStandardId: "setu:employment",
      governedVersion: "2.1",
      fieldId,
      timeWindowStart: "2026-08-11T09:00:00.000Z",
      timeWindowEnd: "2026-08-11T10:00:00.000Z",
      observationCount: 5,
      presentCount
    }
  });
  const events = [
    summary("participant-a", "setu:employee.startDate", 0),
    summary("participant-b", "setu:employee.startDate", 0),
    summary("participant-a", "setu:employee.role", 2),
    summary("participant-b", "setu:employee.role", 3)
  ];
  const rows = buildFieldUsage(events);

  assert.equal(rows[0].fieldId, "setu:employee.startDate");
  assert.equal(rows[0].observationCount, 10);
  assert.equal(rows[0].presentCount, 0);
  assert.equal(rows[0].usageRate, 0);
  assert.equal(rows[0].participantCount, 2);
  assert.equal(rows[1].usageRate, 0.5);
  assert.equal(buildFieldUsage(events, { artefactVersion: "2.1" }).length, 2);
  assert.equal(buildFieldUsage(events, { artefactVersion: "2.0" }).length, 0);
});

test("compares controlled SETU HumanResource usage without exposing message values", () => {
  const summary = (participantId, start, end, observationCount, versionCount, presentCount) => event({
    timestamp: end,
    eventType: "business-message.usage.summary",
    source: { participantId },
    attributes: {
      scope: "business-message",
      evidenceMode: "controlled-demo",
      governedStandardId: "SETU HumanResource",
      governedVersion: "2.0.1",
      fieldId: "HumanResource / pay rates",
      timeWindowStart: start,
      timeWindowEnd: end,
      observationCount,
      versionCount,
      eligibleCount: versionCount,
      presentCount
    }
  });
  const events = [
    summary("participant-a", "2025-04-01T00:00:00.000Z", "2025-06-30T23:59:59.000Z", 50, 30, 13),
    summary("participant-b", "2025-04-01T00:00:00.000Z", "2025-06-30T23:59:59.000Z", 50, 30, 14),
    summary("participant-a", "2026-04-01T00:00:00.000Z", "2026-06-30T23:59:59.000Z", 50, 36, 11),
    summary("participant-b", "2026-04-01T00:00:00.000Z", "2026-06-30T23:59:59.000Z", 50, 37, 12)
  ];

  const rows = buildBusinessMessageUsage(events);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    {
      observations: rows[0].observationCount,
      versions: rows[0].versionCount,
      adoption: rows[0].versionAdoptionRate,
      present: rows[0].presentCount,
      population: rows[0].fieldPopulationRate,
      populationDelta: rows[0].fieldPopulationDelta,
      participants: rows[0].participantCount
    },
    {
      observations: 100,
      versions: 73,
      adoption: 0.73,
      present: 23,
      population: 23 / 73,
      populationDelta: (23 / 73) - 0.45,
      participants: 2
    }
  );
  assert.equal(buildBusinessMessageUsage(events.slice(0, 1)).length, 0);
});

test("counts observed participants across the complete filtered history", () => {
  const events = Array.from({ length: 140 }, (_, index) => event({
    eventType: "catalog.dataset.observed",
    source: { participantId: `participant-${index % 14}` }
  }));

  assert.equal(buildReport(events).participantCount, 14);
  assert.equal(
    buildReport(events, { participantId: "participant-3" }).participantCount,
    1
  );
});

test("scopes evolution metrics to the selected artefact", () => {
  const report = buildReport([
    event({
      artefacts: [
        { type: "ontology", reference: "urn:demo:ontology", version: "2.0" },
        { type: "schema", reference: "urn:demo:legacy-schema", version: "1.0", deprecated: true }
      ]
    })
  ], {
    artefactType: "ontology",
    artefactReference: "urn:demo:ontology",
    artefactVersion: "2.0"
  });

  const adoption = report.evolution.find((metric) => metric.metricName === "artefact_version_adoption_rate");
  const deprecated = report.evolution.find((metric) => metric.metricName === "deprecated_artefact_usage_rate");
  assert.deepEqual(
    { count: adoption.count, adoption: adoption.metricValue, deprecated: deprecated.metricValue },
    { count: 1, adoption: 1, deprecated: 0 }
  );
});
