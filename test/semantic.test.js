import assert from "node:assert/strict";
import test from "node:test";

import { buildFieldUsage, buildVersionValidation } from "../src/semantic.js";

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
  const rows = buildFieldUsage([
    summary("participant-a", "setu:employee.startDate", 0),
    summary("participant-b", "setu:employee.startDate", 0),
    summary("participant-a", "setu:employee.role", 2),
    summary("participant-b", "setu:employee.role", 3)
  ]);

  assert.equal(rows[0].fieldId, "setu:employee.startDate");
  assert.equal(rows[0].observationCount, 10);
  assert.equal(rows[0].presentCount, 0);
  assert.equal(rows[0].usageRate, 0);
  assert.equal(rows[0].participantCount, 2);
  assert.equal(rows[1].usageRate, 0.5);
});
