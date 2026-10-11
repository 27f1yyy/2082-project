const API_BASE = "http://127.0.0.1:8000";

const map = L.map("map").setView([-37.0, 144.5], 6);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let solutionLayer = null;
let isRunning = false;
let isUploading = false;
let speciesLoaded = false;
let allSpecies = [];
let selectedSpecies = new Set();
// In-memory snapshots only: no GeoJSON is retained for the comparison.
let previousScenario = null;
let latestScenario = null;

const targetSlider = document.getElementById("target");
const targetValue = document.getElementById("targetValue");
const formulationSelect = document.getElementById("formulation");
const formulationHelp = document.getElementById("formulationHelp");
const budgetGroup = document.getElementById("budgetGroup");
const budgetInput = document.getElementById("budget");
const runButton = document.getElementById("runButton");
const status = document.getElementById("status");
const results = document.getElementById("results");
const resultsDescription = document.getElementById("resultsDescription");
const comparison = document.getElementById("comparison");
const comparisonCharts = document.getElementById("comparisonCharts");
const clearComparisonButton = document.getElementById("clearComparison");

const speciesSearch = document.getElementById("speciesSearch");
const speciesCount = document.getElementById("speciesCount");
const speciesList = document.getElementById("speciesList");
const speciesListInfo = document.getElementById("speciesListInfo");
const speciesStatus = document.getElementById("speciesStatus");
const selectAllButton = document.getElementById("selectAllSpecies");
const clearAllButton = document.getElementById("clearAllSpecies");
const retrySpeciesButton = document.getElementById("retrySpecies");
const uploadSpeciesForm = document.getElementById("uploadSpeciesForm");
const newSpeciesName = document.getElementById("newSpeciesName");
const newSpeciesFile = document.getElementById("newSpeciesFile");
const uploadSpeciesButton = document.getElementById("uploadSpeciesButton");
const uploadSpeciesStatus = document.getElementById("uploadSpeciesStatus");

function resetSolution() {
    results.className = "results-placeholder";
    results.textContent = "Run an optimisation to view results.";
    resultsDescription.textContent = "Summary of the current solution.";
    status.textContent = "";
    if (solutionLayer !== null) {
        map.removeLayer(solutionLayer);
        solutionLayer = null;
    }
}

function updateFormulationUI() {
    const isMinSet = formulationSelect.value === "min_set";
    budgetGroup.hidden = isMinSet;
    budgetInput.disabled = isRunning || isMinSet;
    formulationHelp.textContent = isMinSet
        ? "Meet every species target while minimising total conservation cost. No budget is needed."
        : "Minimise unmet conservation targets within a fixed budget.";
    resetSolution();
}

function updateRunAvailability() {
    runButton.disabled = isRunning || isUploading || !speciesLoaded || selectedSpecies.size === 0;
    if (speciesLoaded) {
        speciesCount.textContent = `${selectedSpecies.size} / ${allSpecies.length}`;
    }
}

function renderSpeciesList() {
    const filterText = speciesSearch.value.trim().toLowerCase();
    const filtered = allSpecies.filter(species =>
        species.name.toLowerCase().includes(filterText) ||
        species.id.toLowerCase().includes(filterText)
    );

    // Build text as DOM nodes rather than inserting species names as HTML.
    const fragment = document.createDocumentFragment();
    for (const species of filtered) {
        const label = document.createElement("label");
        label.className = "species-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = species.id;
        checkbox.checked = selectedSpecies.has(species.id);
        checkbox.disabled = isRunning || isUploading;
        label.appendChild(checkbox);
        const name = document.createElement("span");
        name.textContent = species.name;
        label.appendChild(name);
        if (species.source === "uploaded") {
            const badge = document.createElement("span");
            badge.className = "uploaded-badge";
            badge.textContent = "Uploaded";
            label.appendChild(badge);
        }
        fragment.appendChild(label);
    }
    if (filtered.length === 0) {
        const empty = document.createElement("p");
        empty.className = "species-empty";
        empty.textContent = "No matching species.";
        fragment.appendChild(empty);
    }
    speciesList.replaceChildren(fragment);
    speciesListInfo.textContent = `Showing ${filtered.length} of ${allSpecies.length} species`;
    updateRunAvailability();
}

function changeSelection(ids) {
    selectedSpecies = new Set(ids);
    renderSpeciesList();
    speciesStatus.textContent = selectedSpecies.size === 0
        ? "Select at least one species before running optimisation."
        : "";
    resetSolution();
}

async function loadSpecies({preserveSelection = false, selectUploadedId = null} = {}) {
    const previousSelection = new Set(selectedSpecies);
    speciesLoaded = false;
    speciesSearch.disabled = true;
    selectAllButton.disabled = true;
    clearAllButton.disabled = true;
    retrySpeciesButton.hidden = true;
    speciesCount.textContent = "Loading...";
    speciesStatus.textContent = "";
    speciesListInfo.textContent = "";
    speciesList.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "species-empty";
    loading.textContent = "Loading available species...";
    speciesList.appendChild(loading);
    updateRunAvailability();

    try {
        const response = await fetch(`${API_BASE}/species`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.species) || data.species.length === 0 ||
            !Array.isArray(data.uploaded_species)) {
            throw new Error("Unexpected species list from API. Is the latest backend running?");
        }
        const ids = new Set();
        const historic = [];
        const uploaded = [];
        function addEntry(entry, source) {
            if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) {
                throw new Error("Invalid or duplicated species ID in API response");
            }
            ids.add(entry.id);
            const cleanEntry = {id: entry.id, name: String(entry.name || entry.id), source};
            if (source === "uploaded") uploaded.push(cleanEntry);
            else historic.push(cleanEntry);
        }
        for (const entry of data.species) addEntry(entry, "historic");
        for (const entry of data.uploaded_species) addEntry(entry, "uploaded");
        allSpecies = [...uploaded.reverse(), ...historic]; // Most recently uploaded species appear first.
        if (preserveSelection) {
            selectedSpecies = new Set(
                allSpecies.filter(entry => previousSelection.has(entry.id)).map(entry => entry.id)
            );
        } else {
            // Backward-compatible default: all original species, no old uploads.
            selectedSpecies = new Set(historic.map(entry => entry.id));
        }
        if (selectUploadedId !== null) {
            if (!ids.has(selectUploadedId)) throw new Error("Uploaded species not found in refreshed list");
            selectedSpecies.add(selectUploadedId);
        }
        speciesLoaded = true;
        speciesSearch.disabled = isRunning || isUploading;
        selectAllButton.disabled = isRunning || isUploading;
        clearAllButton.disabled = isRunning || isUploading;
        renderSpeciesList();
        return true;
    } catch (error) {
        console.error("Could not load species:", error);
        speciesLoaded = false;
        speciesCount.textContent = "Unavailable";
        speciesStatus.textContent = `Could not load species: ${error.message}. Check that FastAPI is running.`;
        retrySpeciesButton.hidden = false;
        updateRunAvailability();
        return false;
    }
}

function setRunning(running) {
    isRunning = running;
    formulationSelect.disabled = running || isUploading;
    targetSlider.disabled = running || isUploading;
    budgetInput.disabled = running || isUploading || formulationSelect.value === "min_set";
    speciesSearch.disabled = running || isUploading || !speciesLoaded;
    selectAllButton.disabled = running || isUploading || !speciesLoaded;
    clearAllButton.disabled = running || isUploading || !speciesLoaded;
    for (const checkbox of speciesList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = running || isUploading;
    }
    runButton.textContent = running ? "Running..." : "Run Optimization";
    updateUploadAvailability();
    updateRunAvailability();
}

function formatValue(value, digits = 0) {
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

// The comparison deliberately reports differences without calling either one
// "better": Minimum Set and Minimum Shortfall minimise different objectives.
function formatSignedDifference(value, decimals = 0) {
    if (!Number.isFinite(value)) return "—";
    const fixed = Math.abs(value).toLocaleString(undefined, {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals
    });
    if (Math.abs(value) < Math.pow(10, -decimals) / 2) return decimals ? Number(0).toFixed(decimals) : "0";
    return `${value > 0 ? "+" : "−"}${fixed}`;
}

function readableMetric(value, decimals = 0) {
    return Number.isFinite(value) ? Number(value).toLocaleString(undefined, {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals
    }) : "—";
}

function makeScenario(data, request) {
    const timing = data.timing || {};
    const selectedSpeciesKey = JSON.stringify([...selectedSpecies].sort());
    return {
        formulation: request.formulation,
        target: Number(targetSlider.value),
        budget: request.formulation === "min_shortfall" ? Number(request.budget) : null,
        speciesKey: selectedSpeciesKey,
        speciesCount: Number(data.total_species),
        planningUnits: Number(data.planning_units_selected),
        totalCost: Number(data.total_cost),
        speciesMet: Number(data.species_fully_met),
        totalShortfall: Number(data.total_shortfall),
        solverSeconds: timing.solver_seconds == null ? NaN : Number(timing.solver_seconds),
        totalSeconds: timing.total_seconds == null ? NaN : Number(timing.total_seconds)
    };
}

// Graphical comparison: paired horizontal bars with a shared zero baseline per metric.
// Costs are opportunity-cost units, not monetary amounts; values are independent
// across metrics and should never be compared across separate chart scales.
function renderComparisonCharts(a, b) {
    comparisonCharts.replaceChildren();
    comparisonCharts.hidden = !(a && b);
    if (!(a && b)) return;

    const title = document.createElement("h3");
    title.className = "comparison-charts-title";
    title.textContent = "Visual comparison";
    comparisonCharts.appendChild(title);

    const key = document.createElement("div");
    key.className = "chart-legend";
    for (const [className, label] of [["chart-a", "A · Previous"], ["chart-b", "B · Latest"]]) {
        const item = document.createElement("span");
        const swatch = document.createElement("i");
        swatch.className = `chart-swatch ${className}`;
        swatch.setAttribute("aria-hidden", "true");
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(label));
        key.appendChild(item);
    }
    comparisonCharts.appendChild(key);

    const metrics = [
        {title: "Planning units selected", field: "planningUnits", digits: 0},
        {title: "Total cost", field: "totalCost", digits: 2, suffix: "cost units"},
        {title: "Species with target fully met", field: "speciesMet", digits: 0},
        {title: "Total shortfall", field: "totalShortfall", digits: 0}
    ];
    for (const metric of metrics) {
        const vA = a[metric.field];
        const vB = b[metric.field];
        const card = document.createElement("div");
        card.className = "metric-chart";
        const heading = document.createElement("div");
        heading.className = "metric-chart-header";
        const name = document.createElement("strong");
        name.textContent = metric.title;
        heading.appendChild(name);
        const delta = document.createElement("span");
        delta.className = "metric-chart-delta";
        delta.textContent = `B − A: ${formatSignedDifference(vB - vA, metric.digits)}`;
        heading.appendChild(delta);
        card.appendChild(heading);

        if (!Number.isFinite(vA) || !Number.isFinite(vB) || vA < 0 || vB < 0) {
            const note = document.createElement("p");
            note.className = "metric-chart-note";
            note.textContent = "This metric has no usable non-negative values.";
            card.appendChild(note);
            comparisonCharts.appendChild(card);
            continue;
        }
        const rawMax = Math.max(vA, vB);
        // A zero-versus-zero pair has no visible bars; the exact zero values remain visible.
        const scale = rawMax > 0 ? rawMax : 1;
        const chart = document.createElement("div");
        chart.className = "metric-chart-bars";
        for (const [label, value, css] of [["A", vA, "chart-a"], ["B", vB, "chart-b"]]) {
            const line = document.createElement("div");
            line.className = "metric-chart-line";
            const index = document.createElement("span");
            index.className = "metric-chart-series";
            index.textContent = label;
            const track = document.createElement("div");
            track.className = "metric-chart-track";
            const bar = document.createElement("div");
            bar.className = `metric-chart-bar ${css}`;
            bar.style.width = `${Math.max(0, Math.min(100, (value / scale) * 100))}%`;
            bar.title = `${label}: ${readableMetric(value, metric.digits)}${metric.suffix ? " " + metric.suffix : ""}`;
            track.appendChild(bar);
            // Display B's budget as a dashed guide when it falls within the
            // comparison scale (the same scale is used for A and B cost bars).
            if (metric.field === "totalCost" && Number.isFinite(b.budget) &&
                b.budget >= 0 && b.budget <= scale) {
                const guide = document.createElement("span");
                guide.className = "metric-chart-budget-guide";
                guide.style.left = `${(b.budget / scale) * 100}%`;
                guide.title = `B budget: ${readableMetric(b.budget, 2)} cost units`;
                guide.setAttribute("aria-hidden", "true");
                track.appendChild(guide);
            }
            const number = document.createElement("span");
            number.className = "metric-chart-number";
            number.textContent = readableMetric(value, metric.digits);
            line.append(index, track, number);
            chart.appendChild(line);
        }
        card.appendChild(chart);
        if (metric.field === "totalCost" && Number.isFinite(b.budget)) {
            const budget = document.createElement("p");
            budget.className = "metric-chart-note";
            budget.textContent = `B budget limit: ${readableMetric(b.budget, 2)} cost units`;
            card.appendChild(budget);
        }
        comparisonCharts.appendChild(card);
    }
    const note = document.createElement("p");
    note.className = "comparison-chart-footnote";
    note.textContent = "Each metric uses its own horizontal scale. Chart heights are not comparable across metrics; exact results and solver times are in the table above.";
    comparisonCharts.appendChild(note);
}

function renderComparison() {
    clearComparisonButton.disabled = latestScenario === null;
    renderComparisonCharts(previousScenario, latestScenario);
    comparison.className = "";
    comparison.replaceChildren();

    function createInfo(text) {
        const message = document.createElement("p");
        message.className = "comparison-note";
        message.textContent = text;
        comparison.appendChild(message);
    }
    if (!latestScenario) {
        comparison.className = "comparison-placeholder";
        createInfo("Run two optimisations to compare their results.");
        return;
    }
    if (!previousScenario) {
        createInfo("First scenario saved. Change a parameter or formulation and run again to compare.");
        const first = document.createElement("p");
        first.className = "comparison-first";
        first.textContent = `${latestScenario.formulation === "min_set" ? "Minimum Set" : "Minimum Shortfall"} · ${latestScenario.target}% target · ${latestScenario.speciesCount} species`;
        comparison.appendChild(first);
        return;
    }
    const a = previousScenario;
    const b = latestScenario;
    const desc = document.createElement("div");
    desc.className = "comparison-scenarios";
    for (const [label, snap] of [["A · Previous", a], ["B · Latest", b]]) {
        const card = document.createElement("div");
        card.className = "comparison-scenario";
        const heading = document.createElement("strong");
        heading.textContent = label;
        card.appendChild(heading);
        const details = document.createElement("p");
        const mode = snap.formulation === "min_set" ? "Minimum Set" : "Minimum Shortfall";
        const budget = snap.budget == null ? "No budget" : `Budget ${formatValue(snap.budget, 2)}`;
        details.textContent = `${mode} · ${snap.target}% target · ${snap.speciesCount} species · ${budget}`;
        card.appendChild(details);
        desc.appendChild(card);
    }
    comparison.appendChild(desc);

    if (a.speciesKey !== b.speciesKey || a.target !== b.target || a.formulation !== b.formulation) {
        const note = document.createElement("p");
        note.className = "comparison-warning";
        const reasons = [];
        if (a.speciesKey !== b.speciesKey) reasons.push("selected species");
        if (a.target !== b.target) reasons.push("conservation target");
        if (a.formulation !== b.formulation) reasons.push("optimisation objective");
        note.textContent = `Scenarios differ in ${reasons.join(", ")}. Differences describe the outcomes, not which solution is better.`;
        comparison.appendChild(note);
    }

    const table = document.createElement("table");
    table.className = "comparison-table";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Metric", "A", "B", "B − A"]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = label;
        header.appendChild(th);
    }
    thead.appendChild(header);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    const rows = [
        ["Cost", "totalCost", 2],
        ["Planning units", "planningUnits", 0],
        ["Species met", "speciesMet", 0],
        ["Total species", "speciesCount", 0],
        ["Shortfall", "totalShortfall", 2],
        ["Solver time (s)", "solverSeconds", 2],
        ["Backend time (s)", "totalSeconds", 2]
    ];
    for (const [name, key, digits] of rows) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = name;
        tr.appendChild(th);
        for (const value of [readableMetric(a[key], digits), readableMetric(b[key], digits),
            formatSignedDifference(b[key] - a[key], digits)]) {
            const td = document.createElement("td");
            td.textContent = value;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrapper = document.createElement("div");
    wrapper.className = "comparison-table-wrap";
    wrapper.appendChild(table);
    comparison.appendChild(wrapper);
    createInfo("B − A shows the raw difference. Solver and backend times are measured on the server (excluding network transfer).");
}

async function runOptimization() {
    if (isRunning || isUploading) return;
    if (!speciesLoaded || selectedSpecies.size === 0) {
        status.textContent = "Please select at least one species.";
        return;
    }
    const formulation = formulationSelect.value;
    const targetPercent = Number(targetSlider.value);
    const budget = Number(budgetInput.value);

    if (!Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent > 100) {
        status.textContent = "Target must be between 1% and 100%.";
        return;
    }
    if (formulation === "min_shortfall" &&
        (budgetInput.value.trim() === "" || !Number.isFinite(budget) || budget < 0)) {
        status.textContent = "Please enter a valid non-negative budget.";
        return;
    }

    const payload = {formulation, target_pct: targetPercent / 100};
    if (formulation === "min_shortfall") payload.budget = budget;

    // Omitting the field means all ORIGINAL species only (no uploaded layers).
    // Explicit selection is essential whenever any uploaded species is checked.
    const allHistoricSelected = allSpecies
        .filter(species => species.source === "historic")
        .every(species => selectedSpecies.has(species.id));
    const anyUploadedSelected = allSpecies
        .some(species => species.source === "uploaded" && selectedSpecies.has(species.id));
    if (!allHistoricSelected || anyUploadedSelected) {
        payload.selected_species = allSpecies
            .filter(species => selectedSpecies.has(species.id))
            .map(species => species.id);
    }

    setRunning(true);
    status.textContent = `Solving scenario for ${selectedSpecies.size} species...`;

    try {
        const response = await fetch(`${API_BASE}/optimize`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorPayload = await response.json().catch(() => null);
            const details = errorPayload?.detail;
            throw new Error(typeof details === "string" ? details : `HTTP ${response.status}`);
        }
        const data = await response.json();
        if (solutionLayer !== null) map.removeLayer(solutionLayer);
        solutionLayer = L.geoJSON(data.selected_units, {
            style: {weight: 0.4, opacity: 0.8, fillOpacity: 0.65}
        }).addTo(map);
        if (solutionLayer.getBounds().isValid()) {
            map.fitBounds(solutionLayer.getBounds(), {padding: [20, 20]});
        }
        const modeName = data.formulation === "min_set" ? "Minimum Set" : "Minimum Shortfall";
        resultsDescription.textContent = `${modeName} solution at ${targetPercent}% conservation target for ${data.total_species} species.`;
        results.className = "";
        results.innerHTML = `
            <div class="result-grid">
                <div class="result-card">
                    <span class="label">PLANNING UNITS</span>
                    <span class="value">${formatValue(data.planning_units_selected)}</span>
                </div>
                <div class="result-card">
                    <span class="label">TOTAL COST (COST UNITS)</span>
                    <span class="value">${formatValue(data.total_cost, 2)}</span>
                </div>
                <div class="result-card">
                    <span class="label">SPECIES MET</span>
                    <span class="value">${formatValue(data.species_fully_met)} / ${formatValue(data.total_species)}</span>
                </div>
                <div class="result-card">
                    <span class="label">TOTAL SHORTFALL</span>
                    <span class="value">${formatValue(data.total_shortfall, 2)}</span>
                </div>
                <div class="result-card">
                    <span class="label">SOLVER TIME</span>
                    <span class="value">${readableMetric(data.timing?.solver_seconds == null ? NaN : Number(data.timing.solver_seconds), 2)} s</span>
                </div>
                <div class="result-card">
                    <span class="label">BACKEND TIME</span>
                    <span class="value">${readableMetric(data.timing?.total_seconds == null ? NaN : Number(data.timing.total_seconds), 2)} s</span>
                </div>
            </div>`;
        // Retain only the two most recent successful run summaries.
        previousScenario = latestScenario;
        latestScenario = makeScenario(data, payload);
        renderComparison();
        status.textContent = `${modeName} optimisation complete.`;
    } catch (error) {
        console.error(error);
        status.textContent = `Optimisation failed: ${error.message}`;
    } finally {
        setRunning(false);
    }
}

function updateUploadAvailability() {
    const disabled = isRunning || isUploading;
    newSpeciesName.disabled = disabled;
    newSpeciesFile.disabled = disabled;
    uploadSpeciesButton.disabled = disabled;
    uploadSpeciesButton.textContent = isUploading ? "Uploading..." : "Upload Species";
}

async function uploadNewSpecies(event) {
    event.preventDefault();
    if (isRunning || isUploading) return;

    const name = newSpeciesName.value.trim();
    const file = newSpeciesFile.files?.[0];
    if (!name || name.length > 100 || !file) {
        uploadSpeciesStatus.textContent = "Enter a species name and choose a GeoTIFF file.";
        return;
    }
    if (!/\.tiff?$/i.test(file.name)) {
        uploadSpeciesStatus.textContent = "Choose a .tif or .tiff GeoTIFF file.";
        return;
    }
    if (file.size === 0 || file.size > 50 * 1024 * 1024) {
        uploadSpeciesStatus.textContent = "File must be non-empty and at most 50 MiB.";
        return;
    }
    const body = new FormData();
    body.append("name", name);
    body.append("file", file);
    isUploading = true;
    updateUploadAvailability();
    updateRunAvailability();
    // Prevent selection changes during upload.
    speciesSearch.disabled = true;
    selectAllButton.disabled = true;
    clearAllButton.disabled = true;
    for (const checkbox of speciesList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = true;
    }
    uploadSpeciesStatus.textContent = `Uploading ${file.name}...`;
    try {
        // Let the browser supply the multipart/form-data boundary.
        const response = await fetch(`${API_BASE}/species/upload`, {method: "POST", body});
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const detail = data?.detail;
            const message = typeof detail === "string" ? detail : `HTTP ${response.status}`;
            throw new Error(message);
        }
        const newId = data?.species?.id;
        if (typeof newId !== "string" || !newId) {
            throw new Error("Upload response did not include a new species ID");
        }
        const loaded = await loadSpecies({preserveSelection: true, selectUploadedId: newId});
        if (!loaded) {
            uploadSpeciesStatus.textContent = "Upload saved, but species list refresh failed. Please retry loading.";
            return;
        }
        // Uploaded species are placed first in the list, and are already selected.
        speciesSearch.value = "";
        renderSpeciesList();
        newSpeciesName.value = "";
        newSpeciesFile.value = "";
        resetSolution();
        uploadSpeciesStatus.textContent = `Uploaded ${name} successfully. It is selected for the next optimisation.`;
    } catch (error) {
        console.error("Species upload failed:", error);
        uploadSpeciesStatus.textContent = `Upload failed: ${error.message}`;
    } finally {
        isUploading = false;
        updateUploadAvailability();
        speciesSearch.disabled = !speciesLoaded;
        selectAllButton.disabled = !speciesLoaded;
        clearAllButton.disabled = !speciesLoaded;
        for (const checkbox of speciesList.querySelectorAll('input[type="checkbox"]')) {
            checkbox.disabled = !speciesLoaded;
        }
        updateRunAvailability();
    }
}

uploadSpeciesForm.addEventListener("submit", uploadNewSpecies);
formulationSelect.addEventListener("change", updateFormulationUI);
targetSlider.addEventListener("input", () => {
    targetValue.textContent = `${targetSlider.value}%`;
    resetSolution();
});
budgetInput.addEventListener("input", resetSolution);
speciesSearch.addEventListener("input", renderSpeciesList);
selectAllButton.addEventListener("click", () => changeSelection(allSpecies.map(species => species.id)));
clearAllButton.addEventListener("click", () => changeSelection([]));
retrySpeciesButton.addEventListener("click", () => loadSpecies({preserveSelection: selectedSpecies.size > 0}));
speciesList.addEventListener("change", event => {
    const checkbox = event.target;
    if (checkbox.tagName !== "INPUT" || checkbox.type !== "checkbox") return;
    if (checkbox.checked) selectedSpecies.add(checkbox.value);
    else selectedSpecies.delete(checkbox.value);
    updateRunAvailability();
    speciesStatus.textContent = selectedSpecies.size === 0
        ? "Select at least one species before running optimisation."
        : "";
    resetSolution();
});
runButton.addEventListener("click", runOptimization);
clearComparisonButton.addEventListener("click", () => {
    previousScenario = null;
    latestScenario = null;
    renderComparison();
});

updateFormulationUI();
renderComparison();
loadSpecies();
