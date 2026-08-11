const elements = {
  appShell: document.querySelector("#appShell"),
  filterToggleButton: document.querySelector("#filterToggleButton"),
  filterShowButton: document.querySelector("#filterShowButton"),
  filtersPanel: document.querySelector("#filtersPanel"),
  refreshButton: document.querySelector("#refreshButton"),
  autoRefreshToggle: document.querySelector("#autoRefreshToggle"),
  refreshStatus: document.querySelector("#refreshStatus"),
  participantFilter: document.querySelector("#participantFilter"),
  metricFilter: document.querySelector("#metricFilter"),
  ontologyFilter: document.querySelector("#ontologyFilter"),
  artefactTypeFilter: document.querySelector("#artefactTypeFilter"),
  artefactVersionFilter: document.querySelector("#artefactVersionFilter"),
  deprecatedFilter: document.querySelector("#deprecatedFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  dateFromDay: document.querySelector("#dateFromDay"),
  dateFromMonth: document.querySelector("#dateFromMonth"),
  dateFromYear: document.querySelector("#dateFromYear"),
  dateToDay: document.querySelector("#dateToDay"),
  dateToMonth: document.querySelector("#dateToMonth"),
  dateToYear: document.querySelector("#dateToYear"),
  dateRangeLabel: document.querySelector("#dateRangeLabel"),
  summaryGrid: document.querySelector("#summaryGrid"),
  ontologyCount: document.querySelector("#ontologyCount"),
  selectedOntology: document.querySelector("#selectedOntology"),
  participantCount: document.querySelector("#participantCount"),
  participantsBody: document.querySelector("#participantsBody"),
  visualizationGrid: document.querySelector("#visualizationGrid"),
  transactionCount: document.querySelector("#transactionCount"),
  transactionShowMoreButton: document.querySelector("#transactionShowMoreButton"),
  transactionsBody: document.querySelector("#transactionsBody"),
  eventCount: document.querySelector("#eventCount"),
  eventShowMoreButton: document.querySelector("#eventShowMoreButton"),
  eventsBody: document.querySelector("#eventsBody"),
  drilldownOverlay: document.querySelector("#drilldownOverlay"),
  drilldownCloseButton: document.querySelector("#drilldownCloseButton"),
  drilldownTitle: document.querySelector("#drilldownTitle"),
  drilldownSubtitle: document.querySelector("#drilldownSubtitle"),
  drilldownBody: document.querySelector("#drilldownBody")
};

let refreshInProgress = false;
let autoRefreshTimer;
let streamRefreshTimer;
let artefactOptions = [];
let latestTransactions = [];
let latestEvents = [];
let showAllTransactions = false;
let showAllEvents = false;
let drilldowns = new Map();
const autoRefreshIntervalMs = 5000;
const previewRowLimit = 5;
const dateSliderStart = new Date("2020-01-01T00:00:00.000Z");

for (const element of [
  elements.refreshButton,
  elements.participantFilter,
  elements.metricFilter,
  elements.ontologyFilter,
  elements.artefactTypeFilter,
  elements.artefactVersionFilter,
  elements.deprecatedFilter,
  elements.statusFilter
]) {
  element.addEventListener("change", loadDashboard);
}
for (const element of dateInputs()) {
  element.addEventListener("change", () => {
    normalizeDateRangeControls();
    loadDashboard();
  });
}
elements.refreshButton.addEventListener("click", loadDashboard);
elements.autoRefreshToggle.addEventListener("change", updateAutoRefresh);
elements.filterToggleButton.addEventListener("click", toggleFilters);
elements.filterShowButton.addEventListener("click", toggleFilters);
elements.visualizationGrid.addEventListener("click", handleDrilldownClick);
elements.drilldownCloseButton.addEventListener("click", closeDrilldown);
elements.drilldownOverlay.addEventListener("click", (event) => {
  if (event.target === elements.drilldownOverlay) closeDrilldown();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.drilldownOverlay.hidden) closeDrilldown();
});
elements.transactionShowMoreButton.addEventListener("click", () => {
  showAllTransactions = !showAllTransactions;
  renderTransactions(latestTransactions);
});
elements.eventShowMoreButton.addEventListener("click", () => {
  showAllEvents = !showAllEvents;
  renderEvents(latestEvents);
});

setupDateSlider();
await loadDashboard();
connectEventStream();
updateAutoRefresh();

async function loadDashboard() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  setRefreshStatus("Refreshing...");
  try {
    const query = buildQuery();
    const [
      eventsPage,
      transactionsPage,
      report,
      participantsPage,
      artefactsPage,
      versionValidationPage,
      fieldUsagePage
    ] = await Promise.all([
      getJson(`/api/events?take=100${query}`),
      getJson(`/api/transactions?${query.slice(1)}`),
      getJson(`/api/report?${query.slice(1)}`),
      getJson("/api/participants"),
      getJson(`/api/artefacts?${participantAndDateQuery().slice(1)}`),
      getJson(`/api/version-validation?${query.slice(1)}`),
      getJson(`/api/field-usage?${query.slice(1)}`)
    ]);

    artefactOptions = artefactsPage.data;
    renderOntologyOptions(artefactOptions);
    renderSelectedOntology(artefactOptions);
    renderArtefactDimensionOptions(artefactOptions);
    renderSummary(eventsPage, transactionsPage);
    renderParticipants(participantsPage.data);
    latestTransactions = transactionsPage.data;
    latestEvents = eventsPage.data;
    renderVisualizations(
      report,
      eventsPage.data,
      artefactOptions,
      versionValidationPage.data,
      fieldUsagePage.data
    );
    renderTransactions(transactionsPage.data);
    renderEvents(eventsPage.data);
    setRefreshStatus(`Updated ${formatTime(new Date())}`);
  } catch (error) {
    setRefreshStatus("Refresh failed");
    console.error(error);
  } finally {
    refreshInProgress = false;
  }
}

function renderParticipants(participants) {
  elements.participantCount.textContent = `${participants.length} registered`;
  elements.participantsBody.innerHTML = participants.length
    ? participants.map((participant) => `
      <tr>
        <td>${escapeText(participant.participantId)}</td>
        <td>${escapeText(participant.displayName ?? "")}</td>
        <td>${badge(participant.status)}</td>
        <td>${participant.eventCount ?? 0}</td>
        <td>${participant.failureCount ?? 0}</td>
        <td>${formatDate(participant.lastSeenAt ?? participant.latestEventAt)}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No participants registered yet.");
}

function updateAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }

  if (elements.autoRefreshToggle.checked) {
    autoRefreshTimer = setInterval(loadDashboard, autoRefreshIntervalMs);
    setRefreshStatus(`Auto refresh every ${autoRefreshIntervalMs / 1000}s`);
  } else {
    setRefreshStatus("Auto refresh paused");
  }
}

function toggleFilters() {
  const hidden = elements.appShell.classList.toggle("filters-hidden");
  elements.filterToggleButton.title = hidden ? "Show filters" : "Hide filters";
}

function connectEventStream() {
  if (!window.EventSource) {
    return;
  }

  const source = new EventSource("/api/events/stream");
  source.addEventListener("semantic-events", () => {
    setRefreshStatus("New semantic events received");
    if (streamRefreshTimer) clearTimeout(streamRefreshTimer);
    streamRefreshTimer = setTimeout(loadDashboard, 250);
  });
  source.onerror = () => {
    setRefreshStatus("Real-time updates reconnecting...");
  };
}

function setRefreshStatus(message) {
  elements.refreshStatus.textContent = message;
}

function buildQuery() {
  const params = new URLSearchParams();
  if (elements.participantFilter.value) params.set("participantId", elements.participantFilter.value);
  const selectedArtefact = selectedArtefactFilter();
  if (selectedArtefact) {
    params.set("artefactType", selectedArtefact.type);
    params.set("artefactReference", selectedArtefact.reference);
    if (selectedArtefact.version) params.set("artefactVersion", selectedArtefact.version);
  } else {
    if (elements.artefactTypeFilter.value) params.set("artefactType", elements.artefactTypeFilter.value);
    if (elements.artefactVersionFilter.value) params.set("artefactVersion", elements.artefactVersionFilter.value);
  }
  if (elements.deprecatedFilter.value) params.set("artefactDeprecated", elements.deprecatedFilter.value);
  if (elements.statusFilter.value) params.set("status", elements.statusFilter.value);
  const dateRange = selectedDateRange();
  params.set("from", dateRange.from.toISOString());
  params.set("to", dateRange.to.toISOString());
  const value = params.toString();
  return value ? `&${value}` : "";
}

function participantAndDateQuery() {
  const params = new URLSearchParams();
  if (elements.participantFilter.value) params.set("participantId", elements.participantFilter.value);
  if (elements.deprecatedFilter.value) params.set("artefactDeprecated", elements.deprecatedFilter.value);
  const dateRange = selectedDateRange();
  params.set("from", dateRange.from.toISOString());
  params.set("to", dateRange.to.toISOString());
  const value = params.toString();
  return value ? `&${value}` : "";
}

function setupDateSlider() {
  populateMonthSelect(elements.dateFromMonth);
  populateMonthSelect(elements.dateToMonth);
  setDateControls("from", dateSliderStart);
  setDateControls("to", new Date());
  normalizeDateRangeControls();
}

function selectedDateRange() {
  const from = dateFromControls("from");
  const to = dateFromControls("to");
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

function normalizeDateRangeControls() {
  const today = dateAtUtcMidnight(new Date());
  let from = clampDate(dateFromControls("from"), dateSliderStart, today);
  let to = clampDate(dateFromControls("to"), dateSliderStart, today);
  if (from > to) {
    to = new Date(from);
  }
  setDateControls("from", from);
  setDateControls("to", to);
  elements.dateRangeLabel.textContent = `${formatDateOnly(from)} to ${formatDateOnly(to)}`;
}

function dateInputs() {
  return [
    elements.dateFromDay,
    elements.dateFromMonth,
    elements.dateFromYear,
    elements.dateToDay,
    elements.dateToMonth,
    elements.dateToYear
  ];
}

function populateMonthSelect(select) {
  select.innerHTML = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(2020, index, 1));
    const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
    return `<option value="${index + 1}">${month}</option>`;
  }).join("");
}

function dateFromControls(prefix) {
  const day = Number(elements[`date${capitalize(prefix)}Day`].value || 1);
  const month = Number(elements[`date${capitalize(prefix)}Month`].value || 1);
  const year = Number(elements[`date${capitalize(prefix)}Year`].value || 2020);
  const maxDay = daysInMonth(year, month);
  return new Date(Date.UTC(year, month - 1, Math.min(Math.max(day, 1), maxDay)));
}

function setDateControls(prefix, value) {
  const date = dateAtUtcMidnight(value);
  elements[`date${capitalize(prefix)}Day`].value = String(date.getUTCDate());
  elements[`date${capitalize(prefix)}Month`].value = String(date.getUTCMonth() + 1);
  elements[`date${capitalize(prefix)}Year`].value = String(date.getUTCFullYear());
  elements[`date${capitalize(prefix)}Year`].max = String(new Date().getUTCFullYear());
}

function dateAtUtcMidnight(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function clampDate(date, min, max) {
  if (date < min) return new Date(min);
  if (date > max) return new Date(max);
  return date;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function daysBetween(start, end) {
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.floor((endUtc - startUtc) / 86400000));
}

function selectedArtefactFilter() {
  if (!elements.ontologyFilter.value) return undefined;
  try {
    return JSON.parse(elements.ontologyFilter.value);
  } catch {
    return undefined;
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function renderSummary(eventsPage, transactionsPage) {
  const events = eventsPage.data;
  const failures = events.filter((event) => event.status === "failure").length;
  const successes = events.filter((event) => event.status === "success").length;
  const participants = new Set(events.map((event) => event.source?.participantId).filter(Boolean));
  const successRate = events.length ? successes / events.length : 0;

  elements.summaryGrid.innerHTML = [
    summaryCard("Participants", participants.size),
    summaryCard("Transactions", transactionsPage.total),
    summaryCard("Recent events", eventsPage.total),
    summaryCard("Success rate", formatRate(successRate), failures ? `${failures} failures` : "no failures")
  ].join("");
}

function renderOntologyOptions(artefacts) {
  const currentValue = elements.ontologyFilter.value;
  const options = artefacts
    .filter((artefact) => isOntologyArtefact(artefact.type))
    .map((artefact) => {
      const value = escapeText(JSON.stringify({
        type: artefact.type,
        reference: artefact.reference,
        version: artefact.version
      }));
      const version = artefact.version ? ` v${artefact.version}` : " unversioned";
      return `<option value="${value}">${escapeText(label(artefact.type))}: ${escapeText(artefact.reference)}${escapeText(version)}</option>`;
    });

  elements.ontologyFilter.innerHTML = [
    '<option value="">All semantic artefacts</option>',
    ...options
  ].join("");

  if ([...elements.ontologyFilter.options].some((option) => option.value === currentValue)) {
    elements.ontologyFilter.value = currentValue;
  }
}

function renderArtefactDimensionOptions(artefacts) {
  preserveSelect(elements.artefactTypeFilter, [
    '<option value="">All artefact types</option>',
    ...unique(artefacts.map((artefact) => artefact.type).filter(Boolean))
      .map((type) => `<option value="${escapeText(type)}">${escapeText(label(type))}</option>`)
  ]);

  const typeFilter = elements.artefactTypeFilter.value;
  preserveSelect(elements.artefactVersionFilter, [
    '<option value="">All versions</option>',
    ...unique(artefacts
      .filter((artefact) => !typeFilter || artefact.type === typeFilter)
      .map((artefact) => artefact.version || "unversioned"))
      .map((version) => `<option value="${escapeText(version === "unversioned" ? "" : version)}">${escapeText(version)}</option>`)
  ]);
}

function preserveSelect(select, optionHtml) {
  const currentValue = select.value;
  select.innerHTML = optionHtml.join("");
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}

function renderSelectedOntology(artefacts) {
  const selected = selectedArtefactFilter();
  const ontologyArtefacts = artefacts.filter((artefact) => isOntologyArtefact(artefact.type));
  elements.ontologyCount.textContent = `${ontologyArtefacts.length} available`;

  if (!selected) {
    elements.selectedOntology.innerHTML = `
      <div class="ontology-empty">Select an ontology or semantic artefact to inspect its observed version and usage.</div>
    `;
    return;
  }

  const artefact = artefacts.find((candidate) =>
    candidate.type === selected.type &&
    candidate.reference === selected.reference &&
    (candidate.version ?? "") === (selected.version ?? "")
  );

  if (!artefact) {
    elements.selectedOntology.innerHTML = `<div class="ontology-empty">Selected artefact is not present in the current filter window.</div>`;
    return;
  }

  elements.selectedOntology.innerHTML = `
    <div class="ontology-detail-grid">
      <div>
        <div class="detail-label">Artefact</div>
        <div class="detail-value">${escapeText(artefact.reference)}</div>
      </div>
      <div>
        <div class="detail-label">Type</div>
        <div class="detail-value">${escapeText(label(artefact.type))}</div>
      </div>
      <div>
        <div class="detail-label">Version</div>
        <div class="detail-value">${escapeText(artefact.version ?? "unversioned")}</div>
      </div>
      <div>
        <div class="detail-label">Observed Events</div>
        <div class="detail-value">${artefact.eventCount}</div>
      </div>
      <div>
        <div class="detail-label">Participants</div>
        <div class="detail-value">${artefact.participantIds.length}</div>
      </div>
      <div>
        <div class="detail-label">Datasets</div>
        <div class="detail-value">${artefact.datasetPseudonyms.length}</div>
      </div>
    </div>
  `;
}

function renderTransactions(transactions) {
  const visibleTransactions = showAllTransactions ? transactions : transactions.slice(0, previewRowLimit);
  elements.transactionCount.textContent = `${visibleTransactions.length}/${transactions.length} grouped flows`;
  elements.transactionShowMoreButton.hidden = transactions.length <= previewRowLimit;
  elements.transactionShowMoreButton.textContent = showAllTransactions ? "Show less" : "Show more";
  elements.transactionsBody.innerHTML = visibleTransactions.length
    ? visibleTransactions.map((transaction) => `
      <tr>
        <td>${badge(transaction.status)}</td>
        <td>${escapeText(transaction.sourceParticipants.join(", ") || "unknown")}</td>
        <td>${escapeText(transaction.datasetPseudonym ?? "")}</td>
        <td>${transaction.eventCount}</td>
        <td>${escapeText(transaction.eventTypes.slice(0, 4).join(", "))}</td>
        <td>${formatDate(transaction.lastSeenAt)}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No transactions recorded yet.");
}

function renderVisualizations(report, events, artefacts, versionValidation, fieldUsage) {
  drilldowns = new Map();
  const metricCards = [
    {
      name: "semantic_model_coverage",
      html: semanticCoverageCard(findMetric(report, "semantic_model_coverage"), events)
    },
    {
      name: "schema_reference_coverage",
      html: schemaCoverageCard(findMetric(report, "schema_reference_coverage"), events)
    },
    {
      name: "artefact_version_adoption_rate",
      html: versionAdoptionCard(findMetric(report, "artefact_version_adoption_rate"), artefacts, events)
    },
    {
      name: "deprecated_artefact_usage_rate",
      html: deprecatedUsageCard(findMetric(report, "deprecated_artefact_usage_rate"), artefacts, events)
    },
    {
      name: "validation_error_rate",
      html: validationErrorCard(findMetric(report, "validation_error_rate"), events)
    },
    {
      name: "version_validation_errors",
      html: versionValidationCard(versionValidation)
    },
    {
      name: "semantic_field_usage",
      html: fieldUsageCard(fieldUsage)
    }
  ].filter((card) => !elements.metricFilter.value || card.name === elements.metricFilter.value);

  elements.visualizationGrid.innerHTML = metricCards.map((card) => card.html).join("");
}

function versionValidationCard(rows) {
  const topRows = rows.slice(0, 8);
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Validation Errors by Governed Version</h2>
          <div class="muted">Association only; this does not establish causation.</div>
        </div>
        <strong>${rows.reduce((total, row) => total + row.failureCount, 0)} failures</strong>
      </div>
      ${miniTable(
        ["Standard", "Version", "Validations", "Failures", "Error rate", "Share of failures"],
        topRows.map((row) => ({
          cells: [
            row.governedStandardId,
            row.version,
            row.validationCount,
            row.failureCount,
            formatRate(row.errorRate),
            formatRate(row.failureShare)
          ]
        }))
      )}
    </article>
  `;
}

function fieldUsageCard(rows) {
  const topRows = rows.slice(0, 12);
  const notObserved = rows.filter((row) => row.presentCount === 0).length;
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Governed Semantic Field Usage</h2>
          <div class="muted">Thresholded presence counts only; no values or raw payloads.</div>
        </div>
        <strong>${notObserved} not observed</strong>
      </div>
      ${miniTable(
        ["Standard", "Version", "Field", "Present / observed", "Usage", "Participants"],
        topRows.map((row) => ({
          cells: [
            row.governedStandardId,
            row.version,
            row.fieldId,
            `${row.presentCount} / ${row.observationCount}`,
            formatRate(row.usageRate),
            row.participantCount
          ]
        }))
      )}
    </article>
  `;
}

function findMetric(report, metricName) {
  return [
    ...report.adoption,
    ...report.friction,
    ...report.evolution,
    ...report.stability
  ].find((metric) => metric.metricName === metricName);
}

function semanticCoverageCard(metric, events) {
  const value = boundedRate(metric?.metricValue ?? 0);
  const adoptionEvents = events.filter((event) => event.dimensions?.includes("adoption"));
  const referencedEvents = adoptionEvents.filter(hasOntologyReference);
  const missingEvents = adoptionEvents.filter((event) => !hasOntologyReference(event));
  const referenced = referencedEvents.length;
  const missing = missingEvents.length;
  const referencedId = addDrilldown("Ontology referenced", "Adoption events with ontology or semantic model artefacts.", referencedEvents);
  const missingId = addDrilldown("Missing ontology", "Adoption events without ontology or semantic model artefacts.", missingEvents);
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Ontology Coverage</h2>
          <div class="muted">${metric?.count ?? 0} adoption observations</div>
        </div>
        <strong>${formatRate(value)}</strong>
      </div>
      <div class="metric-story-body">
        <div class="visual-pane">
          ${donut(value, "#2563eb", referencedId)}
          <div class="legend-row">
            ${drilldownButton(referencedId, '<i class="legend-dot blue"></i>Referenced')}
            ${drilldownButton(missingId, '<i class="legend-dot neutral"></i>Missing')}
          </div>
        </div>
        ${miniTable(["Category", "Events", "Share"], [
          { cells: ["Ontology referenced", referenced, formatRate(value)], drilldownId: referencedId },
          { cells: ["Missing ontology", missing, formatRate(1 - value)], drilldownId: missingId }
        ])}
      </div>
    </article>
  `;
}

function schemaCoverageCard(metric, events) {
  const value = boundedRate(metric?.metricValue ?? 0);
  const adoptionEvents = events.filter((event) => event.dimensions?.includes("adoption"));
  const referencedEvents = adoptionEvents.filter(hasSchemaReference);
  const missingEvents = adoptionEvents.filter((event) => !hasSchemaReference(event));
  const referenced = referencedEvents.length;
  const missing = missingEvents.length;
  const referencedId = addDrilldown("Schema referenced", "Adoption events with schema or OpenAPI artefacts.", referencedEvents);
  const missingId = addDrilldown("Missing schema", "Adoption events without schema or OpenAPI artefacts.", missingEvents);
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Schema Reference Coverage</h2>
          <div class="muted">${metric?.count ?? 0} adoption observations</div>
        </div>
        <strong>${formatRate(value)}</strong>
      </div>
      <div class="metric-story-body">
        <div class="visual-pane">
          <div class="stacked-bar" aria-label="Schema coverage">
            <button class="stacked-segment stacked-present" type="button" data-drilldown="${referencedId}" style="width:${value * 100}%" title="Schema referenced"></button>
            <button class="stacked-segment stacked-missing" type="button" data-drilldown="${missingId}" style="width:${(1 - value) * 100}%" title="Missing schema"></button>
          </div>
          <div class="bar-breakdown">
            ${drilldownButton(referencedId, `<span>Has schema</span><strong>${formatRate(value)}</strong>`)}
            ${drilldownButton(missingId, `<span>Missing schema</span><strong>${formatRate(1 - value)}</strong>`)}
          </div>
        </div>
        ${miniTable(["Category", "Events", "Share"], [
          { cells: ["Schema referenced", referenced, formatRate(value)], drilldownId: referencedId },
          { cells: ["Missing schema", missing, formatRate(1 - value)], drilldownId: missingId }
        ])}
      </div>
    </article>
  `;
}

function versionAdoptionCard(metric, artefacts, events) {
  const versionRows = topVersionRows(artefacts, events);
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Artefact Version Adoption</h2>
          <div class="muted">${metric?.count ?? 0} artefact observations</div>
        </div>
        <strong>${formatRate(boundedRate(metric?.metricValue ?? 0))}</strong>
      </div>
      <div class="metric-story-body">
        <div class="visual-pane">
          <div class="version-bars">
            ${versionRows.length ? versionRows.map((row) => horizontalBar(row.label, row.value, row.max, row.detail, "default", row.drilldownId)).join("") : emptyViz("No versioned artefacts observed.")}
          </div>
        </div>
        ${miniTable(["Artefact", "Version", "Events"], versionRows.map((row) => ({ cells: [row.label, row.version, row.value], drilldownId: row.drilldownId })))}
      </div>
    </article>
  `;
}

function deprecatedUsageCard(metric, artefacts, events) {
  const deprecated = artefacts
    .filter((artefact) => artefact.deprecated)
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, 5)
    .map((artefact) => ({
      ...artefact,
      drilldownId: addDrilldown(
        `Deprecated: ${label(artefact.type)} ${artefact.reference}`,
        `Events using ${artefact.reference} ${artefact.version ?? "unversioned"}.`,
        eventsForArtefact(events, artefact)
      )
    }));
  const max = Math.max(...deprecated.map((artefact) => artefact.eventCount), 1);
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Deprecated Artefact Usage</h2>
          <div class="muted">${metric?.count ?? 0} artefact observations</div>
        </div>
        <strong>${formatRate(boundedRate(metric?.metricValue ?? 0))}</strong>
      </div>
      <div class="metric-story-body">
        <div class="visual-pane">
          <div class="risk-bars">
            ${deprecated.length ? deprecated.map((artefact) =>
              horizontalBar(
                `${label(artefact.type)}: ${artefact.reference}`,
                artefact.eventCount,
                max,
                `${artefact.version ?? "unversioned"} / ${artefact.participantIds.length} participants`,
                "danger",
                artefact.drilldownId
              )
            ).join("") : emptyViz("No deprecated artefact usage in this window.")}
          </div>
        </div>
        ${miniTable(["Deprecated artefact", "Version", "Last seen"], deprecated.map((artefact) => ({
          cells: [
            `${label(artefact.type)}: ${artefact.reference}`,
            artefact.version ?? "unversioned",
            formatDate(artefact.lastSeenAt)
          ],
          drilldownId: artefact.drilldownId
        })))}
      </div>
    </article>
  `;
}

function validationErrorCard(metric, events) {
  const validationEvents = events.filter((event) => event.eventType === "metadata.validation.result");
  const categoryRows = topFailureCategoryRows(validationEvents);
  return `
    <article class="metric-story">
      <div class="viz-heading">
        <div>
          <h2>Semantic Validation Errors</h2>
          <div class="muted">${metric?.count ?? 0} validation observations</div>
        </div>
        <strong>${formatRate(boundedRate(metric?.metricValue ?? 0))}</strong>
      </div>
      <div class="metric-story-body">
        <div class="visual-pane">
          <div class="trend-chart">${validationTrendSvg(validationEvents)}</div>
          <div class="category-bars">
            ${categoryRows.length ? categoryRows.map((row) => horizontalBar(row.label, row.value, row.max, "failures", "warning", row.drilldownId)).join("") : emptyViz("No validation failures in this window.")}
          </div>
        </div>
        ${miniTable(["Failure category", "Failures", "Share"], categoryRows.map((row) => ({
          cells: [
            row.label,
            row.value,
            formatRate(row.total ? row.value / row.total : 0)
          ],
          drilldownId: row.drilldownId
        })))}
      </div>
    </article>
  `;
}

function donut(value, color, drilldownId) {
  return `
    <button class="donut" type="button" data-drilldown="${drilldownId}" style="--value:${value * 100};--donut-color:${color}">
      <span>${formatRate(value)}</span>
    </button>
  `;
}

function horizontalBar(labelText, value, max, detail, tone = "default", drilldownId) {
  const width = max > 0 ? Math.max(4, (value / max) * 100) : 0;
  return `
    <button class="hbar-row drilldown-row-button" type="button" data-drilldown="${drilldownId}">
      <div class="hbar-label">
        <span>${escapeText(labelText)}</span>
        <small>${escapeText(detail)}</small>
      </div>
      <div class="hbar-track"><span class="${tone}" style="width:${width}%"></span></div>
      <strong>${value}</strong>
    </button>
  `;
}

function topVersionRows(artefacts, events) {
  const rows = artefacts
    .filter((artefact) => artefact.version)
    .map((artefact) => {
      const rowEvents = eventsForArtefact(events, artefact);
      return {
        label: `${label(artefact.type)}: ${artefact.reference}`,
        value: artefact.eventCount,
        version: artefact.version,
        detail: `v${artefact.version} / ${artefact.participantIds.length} participants`,
        drilldownId: addDrilldown(
          `${label(artefact.type)} ${artefact.reference} v${artefact.version}`,
          "Events using this artefact version.",
          rowEvents
        )
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const max = Math.max(...rows.map((row) => row.value), 1);
  return rows.map((row) => ({ ...row, max }));
}

function topFailureCategoryRows(events) {
  const counts = new Map();
  for (const event of events) {
    if (event.status !== "failure") continue;
    const key = event.failureCategory || "validation failure";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([labelText, value]) => ({
      label: labelText,
      value,
      drilldownId: addDrilldown(
        `Validation failures: ${labelText}`,
        "Validation result events in this failure category.",
        events.filter((event) => event.status === "failure" && (event.failureCategory || "validation failure") === labelText)
      )
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);
  const max = Math.max(...rows.map((row) => row.value), 1);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return rows.map((row) => ({ ...row, max, total }));
}

function miniTable(headers, rows) {
  return `
    <div class="mini-table-wrap">
      <table class="mini-table">
        <thead>
          <tr>${headers.map((header) => `<th>${escapeText(header)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((row) => `
            <tr${row.drilldownId ? ` class="clickable-row" data-drilldown="${row.drilldownId}"` : ""}>${row.cells.map((cell) => `<td>${escapeText(cell)}</td>`).join("")}</tr>
          `).join("") : `<tr><td colspan="${headers.length}" class="muted">No matching data in this window.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function drilldownButton(drilldownId, html) {
  return `<button class="drilldown-link" type="button" data-drilldown="${drilldownId}">${html}</button>`;
}

function addDrilldown(title, subtitle, events) {
  const id = `drilldown-${drilldowns.size + 1}`;
  drilldowns.set(id, {
    title,
    subtitle,
    events: events.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
  });
  return id;
}

function handleDrilldownClick(event) {
  const trigger = event.target.closest("[data-drilldown]");
  if (!trigger) return;
  const drilldown = drilldowns.get(trigger.dataset.drilldown);
  if (!drilldown) return;
  openDrilldown(drilldown);
}

function openDrilldown(drilldown) {
  elements.drilldownTitle.textContent = drilldown.title;
  elements.drilldownSubtitle.textContent = `${drilldown.events.length} matching events / transaction records`;
  elements.drilldownBody.innerHTML = drilldown.events.length
    ? drilldown.events.map((event) => `
      <tr>
        <td>${formatDate(event.timestamp)}</td>
        <td>${escapeText(event.source?.participantId ?? "unknown")}</td>
        <td>${badge(event.status)}</td>
        <td>${escapeText(event.eventType)}</td>
        <td>${escapeText(event.context?.datasetPseudonym ?? "")}</td>
        <td>${escapeText(transactionLabel(event))}</td>
        <td>${escapeText(artefactList(event))}</td>
      </tr>
    `).join("")
    : emptyRow(7, "No matching events in the current filter window.");
  elements.drilldownOverlay.hidden = false;
  document.body.classList.add("drilldown-open");
}

function closeDrilldown() {
  elements.drilldownOverlay.hidden = true;
  document.body.classList.remove("drilldown-open");
}

function eventsForArtefact(events, artefact) {
  return events.filter((event) => event.artefacts?.some((candidate) =>
    candidate.type === artefact.type &&
    candidate.reference === artefact.reference &&
    (candidate.version ?? "") === (artefact.version ?? "")
  ));
}

function hasOntologyReference(event) {
  return event.artefacts?.some((artefact) => isOntologyArtefact(artefact.type)) ?? false;
}

function hasSchemaReference(event) {
  return event.artefacts?.some((artefact) => ["schema", "openapi-spec"].includes(artefact.type)) ?? false;
}

function transactionLabel(event) {
  return event.context?.correlationId ??
    event.context?.transferId ??
    event.context?.agreementId ??
    event.context?.negotiationId ??
    event.context?.participantPairPseudonym ??
    "not linked";
}

function artefactList(event) {
  return (event.artefacts ?? [])
    .map((artefact) => `${label(artefact.type ?? "unknown")}: ${artefact.reference ?? "unknown"}${artefact.version ? ` v${artefact.version}` : ""}`)
    .join("; ");
}

function validationTrendSvg(events) {
  const buckets = dailyFailureRates(events).slice(-8).map((bucket) => ({
    ...bucket,
    drilldownId: addDrilldown(
      `Validation trend: ${bucket.label}`,
      "Validation result events for this day.",
      bucket.events
    )
  }));
  if (!buckets.length) {
    return emptyViz("No validation events available for trend.");
  }
  const width = 320;
  const height = 96;
  const points = buckets.map((bucket, index) => {
    const x = buckets.length === 1 ? width / 2 : (index / (buckets.length - 1)) * width;
    const y = height - boundedRate(bucket.rate) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Validation error trend">
      <polyline points="${points}" fill="none" stroke="#dc2626" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${buckets.map((bucket, index) => {
        const x = buckets.length === 1 ? width / 2 : (index / (buckets.length - 1)) * width;
        const y = height - boundedRate(bucket.rate) * height;
        return `<circle class="trend-point" data-drilldown="${bucket.drilldownId}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#dc2626"><title>${escapeText(bucket.label)} ${formatRate(bucket.rate)}</title></circle>`;
      }).join("")}
    </svg>
  `;
}

function dailyFailureRates(events) {
  const buckets = new Map();
  for (const event of events) {
    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    const bucket = buckets.get(date) ?? { label: date, total: 0, failures: 0, events: [] };
    bucket.total += 1;
    bucket.failures += event.status === "failure" ? 1 : 0;
    bucket.events.push(event);
    buckets.set(date, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((bucket) => ({ ...bucket, rate: bucket.total ? bucket.failures / bucket.total : 0 }));
}

function emptyViz(text) {
  return `<div class="viz-empty">${escapeText(text)}</div>`;
}

function boundedRate(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function renderEvents(events) {
  const visibleEvents = showAllEvents ? events : events.slice(0, previewRowLimit);
  elements.eventCount.textContent = `${visibleEvents.length}/${events.length} shown`;
  elements.eventShowMoreButton.hidden = events.length <= previewRowLimit;
  elements.eventShowMoreButton.textContent = showAllEvents ? "Show less" : "Show more";
  elements.eventsBody.innerHTML = visibleEvents.length
    ? visibleEvents.map((event) => `
      <tr>
        <td>${formatDate(event.timestamp)}</td>
        <td>${escapeText(event.source?.participantId ?? "unknown")}</td>
        <td>${escapeText(event.eventType)}</td>
        <td>${badge(event.status)}</td>
        <td>${escapeText(event.context?.datasetPseudonym ?? "")}</td>
        <td>${escapeText(event.failureCategory ?? "")}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No events recorded yet.");
}

function summaryCard(labelText, value, footer = "") {
  return `
    <article class="summary-card">
      <div class="summary-label">${labelText}</div>
      <div class="summary-value">${value}</div>
      <div class="muted">${footer}</div>
    </article>
  `;
}

function badge(status) {
  return `<span class="badge ${escapeText(status)}">${escapeText(status)}</span>`;
}

function emptyRow(columns, text) {
  return `<tr><td colspan="${columns}" class="muted">${text}</td></tr>`;
}

function label(value) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isOntologyArtefact(type) {
  return ["ontology", "semantic-model", "base-semantic-model", "vocabulary"].includes(type);
}

function formatMetric(metric) {
  if (metric.metricName.includes("rate") || metric.metricName.includes("coverage") || metric.metricName.includes("score")) {
    return formatRate(metric.metricValue);
  }
  if (metric.metricName.includes("latency")) {
    return `${Math.round(metric.metricValue)} ms`;
  }
  return new Intl.NumberFormat().format(metric.metricValue);
}

function formatRate(value) {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

function formatDateOnly(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium"
  }).format(value);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "medium"
  }).format(value);
}

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
