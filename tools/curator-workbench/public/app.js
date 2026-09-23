// SPDX-License-Identifier: MPL-2.0

const byId = (id) => document.getElementById(id);
let overview;
let lastInputMethod = "programmatic";
let inFlight = false;
const localLatest = {};

const previewParameters = new URLSearchParams(window.location.search);
if (previewParameters.get("contrast") === "forced") {
  document.documentElement.dataset.forcedColourPreview = "true";
}
if (previewParameters.get("scale") === "200") {
  document.documentElement.dataset.textScale = "200";
}
if (previewParameters.get("motion") === "reduced") {
  document.documentElement.dataset.reducedMotionPreview = "true";
}

document.addEventListener("keydown", () => { lastInputMethod = "keyboard"; }, true);
document.addEventListener("pointerdown", () => { lastInputMethod = "pointer"; }, true);

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function value(result, fallback = null) { return result?.ok ? result.value : fallback; }
function identity(text) { return `<span class="identity">${escape(text ?? "Not available")}</span>`; }
function card(title, body) { return `<article class="card"><h3>${escape(title)}</h3>${body}</article>`; }
function availability(result) {
  return result?.ok ? '<span class="badge ok">Available</span>'
    : `<span class="badge failed">Unavailable</span><p>${escape(result?.diagnostic?.message ?? "Unknown failure")}</p>`;
}
function latest(operation) { return localLatest[operation] ?? overview?.latest?.[operation] ?? null; }
function announce(text) { byId("announcements").textContent = text; }
function focusStatus(id) { const element = byId(id); element.focus({ preventScroll: true }); }
function setStatus(id, text, failed = false) {
  const element = byId(id); element.textContent = text; element.classList.toggle("error", failed);
  element.setAttribute("role", failed ? "alert" : "status"); announce(text);
}
function showError(message) {
  const error = byId("errors"); error.textContent = message; error.hidden = false; error.focus(); announce(message);
}
function enterDiagnosticOnlyMode() {
  document.documentElement.dataset.diagnosticOnly = "true";
  document.title = "Project descriptor rejected · FOSS Package Manager curator workbench";
  for (const element of document.querySelectorAll("button, input, select, textarea")) {
    element.disabled = true;
  }
}
function diagnosticText(diagnostic) {
  const details = diagnostic?.details ?? {};
  const location = details.path ? ` Path ${details.path}.` : "";
  const rule = details.rule ? ` Rule ${details.rule}.` : "";
  const supplied = Object.hasOwn(details, "supplied") ? ` Supplied ${JSON.stringify(details.supplied)}.` : "";
  return `${diagnostic?.code ?? "FGPM_WORKBENCH_FAILED"}: ${diagnostic?.message ?? "Unknown failure"}.${location}${rule}${supplied}`;
}
function workspace() { return value(overview?.workspace); }
function packageEntries() { return value(overview?.packages)?.packages ?? []; }
function packageRoot(id) {
  const found = packageEntries().find((entry) => entry.id === id);
  if (!found) throw new Error(`Package ${id} is not known to the manager yet.`);
  return found.root;
}
function fixture() { return overview.fixture; }
function workspaceStage(operations) {
  const current = workspace();
  if (!current) throw new Error("Create or initialise the workspace first.");
  return { name: overview.project.workspace.name, expectedHead: current.revision.identity,
    actor: fixture().actor, operations };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!result.ok && result.diagnostic) {
    const error = new Error(`${result.diagnostic.code}: ${result.diagnostic.message}`);
    error.result = result; throw error;
  }
  return result;
}

async function runAction(operation, parameters, options = {}) {
  if (inFlight) throw new Error("Another operation is already in progress.");
  inFlight = true;
  const statusId = options.statusId ?? "guided-status";
  setStatus(statusId, `Started ${operation}. Waiting for the authoritative manager response.`);
  try {
    const endpoint = options.endpoint ?? (options.surface === "expert"
      ? "/api/action/expert" : "/api/action/guided");
    const result = await fetchJson(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, parameters, relativePaths: options.relativePaths ?? [],
        confirmation: options.confirmation ?? "", requestId: `workbench:${Date.now()}:${operation}`,
        expectation: options.expectation ?? null,
        surface: options.surface ?? "guided", controlId: options.controlId ?? null,
        inputMethod: lastInputMethod }),
    });
    localLatest[operation] = result.result;
    byId(options.resultId ?? "guided-result").textContent = JSON.stringify(result, null, 2);
    setStatus(statusId, `Completed ${operation}. Review the structured result and continue when ready.`);
    await loadOverview({ preserveFocus: true });
    focusStatus(statusId);
    return result.result;
  } catch (error) {
    byId(options.resultId ?? "guided-result").textContent = JSON.stringify(error.result ?? {
      ok: false, message: error.message,
    }, null, 2);
    const denial = error.result?.diagnostic?.code === "FGPM_WORKBENCH_OPERATION_NOT_ALLOWED";
    const profile = error.result?.diagnostic?.details?.profile;
    setStatus(statusId, denial
      ? `Access denied for ${profile ?? "the current client profile"} before manager dispatch: ${operation}.`
      : `Failed ${operation}. ${error.message}. No automatic choice was made.`, true);
    focusStatus(statusId);
    throw error;
  } finally { inFlight = false; }
}

async function loadOverview(options = {}) {
  byId("summary").setAttribute("aria-busy", "true"); byId("errors").hidden = true;
  try {
    const response = await fetch("/api/overview", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok && result.diagnostic) {
      enterDiagnosticOnlyMode();
      showError(`Project descriptor rejected before Workbench entry. ${diagnosticText(result.diagnostic)}`);
      return;
    }
    overview = result;
    render();
    if (!options.preserveFocus && overview.exactBuild && !overview.exactBuild.compatible) {
      announce(`Exact rebuild target mismatch for ${overview.exactBuild.release}. Retained release activation remains available.`);
      focusStatus("target-environment-status");
    } else if (!options.preserveFocus) announce(`Loaded ${overview.project.name}.`);
  } catch (error) { showError(`Overview failed: ${error.message}`); }
  finally { byId("summary").setAttribute("aria-busy", "false"); }
}

function render() {
  const project = overview.project;
  const currentWorkspace = workspace();
  const active = value(overview.active)?.active;
  const runtime = value(overview.runtime);
  const exactBuild = overview.exactBuild;
  const controlDescription = value(overview.manager.control);
  const curatorProfile = controlDescription?.capabilityProfiles?.initialCurator;
  byId("project-title").textContent = `${project.name} curator workbench`;
  byId("project-description").textContent = overview.fixture.description;
  document.title = `${project.name} · FOSS Package Manager curator workbench`;
  byId("fixture-description").textContent = overview.fixture.description;
  byId("summary").innerHTML = [
    card("Project", `<p>${escape(project.name)}</p><p>Descriptor ${identity(project.schema)}</p><p>Current release <strong>${escape(project.current.release)}</strong></p>`),
    card("Manager", `${availability(overview.manager.control)}<p><span class="badge ${overview.manager.matchesDescriptor ? "ok" : "failed"}">${overview.manager.matchesDescriptor ? "Exact configured manager" : "Manager mismatch — mutation blocked"}</span></p><p>Expected ${identity(overview.manager.expectedCommit)}</p><p>Actual ${identity(overview.manager.commit)}</p>`),
    card("Initial curator authority", curatorProfile
      ? `<p>${escape(curatorProfile.operations.length)} semantic operations are agent-allowed.</p><p>Every allowed operation is also marked as ordinary guided-project-supported human access.</p><details><summary>Allowed operation identities</summary><p>${curatorProfile.operations.map((entry) => identity(entry)).join(" ")}</p></details>`
      : "<p>No initial curator profile is available.</p>"),
    card("Workspace", currentWorkspace ? `<p>${escape(currentWorkspace.reference.name)}</p><p>Revision ${identity(currentWorkspace.revision.identity)}</p><p>${currentWorkspace.revision.operations.length} staged operations.</p>` : availability(overview.workspace)),
    card("Current generation", `<p>Declared ${identity(project.current.generation)}</p><p>${active ? `Durably active ${identity(active.generation)}` : "No durable active generation."}</p><p>${runtime?.live ? "Live runtime session." : "No live runtime session."}</p>`),
    card("Portable state", `<p>${escape(project.portableState.mechanism)}</p><p>Journal <strong>${escape(overview.journal.id)}</strong> has ${escape(overview.journal.steps.length)} public steps.</p>`),
    exactBuild ? card("Exact-build target", `<p>Release <strong>${escape(exactBuild.release)}</strong></p><p>Target: ${escape(exactBuild.target.platform)} / ${escape(exactBuild.target.architecture)} / ${escape(exactBuild.target.node)}</p><p>Current: ${escape(exactBuild.current.platform)} / ${escape(exactBuild.current.architecture)} / ${escape(exactBuild.current.node)}</p><p><span class="badge ${exactBuild.compatible ? "ok" : "failed"}">${exactBuild.compatible ? "Compatible exact rebuild" : "Exact rebuild blocked"}</span></p><p>Retained release activation: available. Deliberate new generation without the expected identity: available.</p><p>${exactBuild.mismatches.map((entry) => `${escape(entry.dimension)}: target ${escape(entry.target)}, current ${escape(entry.current)}`).join("; ")}</p>`) : "",
    card("Tests", overview.tests?.ok ? `<p><span class="badge ${overview.tests.value.failed === 0 ? "ok" : "failed"}">${escape(overview.tests.value.passed)} passed · ${escape(overview.tests.value.failed)} failed</span></p><p>${escape(overview.tests.value.scope)}</p>` : "<p>No retained aggregate receipt.</p>"),
  ].join("");
  if (exactBuild) {
    byId("target-environment-status").textContent = exactBuild.compatible
      ? `Current host matches the declared ${exactBuild.release} exact-build target.`
      : `Exact ${exactBuild.release} rebuild is blocked. Importing and activating the retained release remains available.`;
    byId("target-environment-status").setAttribute("role", exactBuild.compatible ? "status" : "alert");
    byId("build-candidate").disabled = !exactBuild.compatible;
    byId("commit-generation").disabled = !exactBuild.compatible;
  }
  renderAuthorityInspection(); renderChoices(); renderScenes(); renderLifecycle(); renderWhy(); renderTrace(); renderExpertOperations();
}

function renderAuthorityInspection() {
  const authority = overview.clientAuthority;
  const pageProfile = authority?.profiles?.[authority.defaultProfile];
  const curatorProfile = authority?.profiles?.["initial-curator"];
  const latestDenial = [...(overview.trace ?? [])]
    .reverse()
    .find((entry) => entry.state === "denied");
  if (latestDenial) {
    setStatus(
      "authority-status",
      `Access denied for ${latestDenial.profile}: ${latestDenial.operation} was rejected before manager dispatch. This is a client-authority denial, not a manager validation failure.`,
      true,
    );
  } else {
    setStatus("authority-status", "No client-authority denial is present in this session.");
  }
  byId("effective-profile-content").innerHTML = pageProfile
    ? `<p>Ordinary page actions use the server-bound <strong>${escape(pageProfile.id)}</strong> profile at ${identity(pageProfile.endpoint)}.</p><p>The initial curator uses its separate server-bound profile with ${escape(curatorProfile?.operations?.length ?? 0)} permitted operations.</p><p>Request attribution fields are observational and grant no authority.</p>`
    : "<p>No server-owned client profile description is available.</p>";
  byId("guided-capability-map").innerHTML = (authority?.guidedHumanRegistry ?? [])
    .map((entry) => `<li>${identity(entry.operation)} — ${escape(entry.kind)} <strong>${escape(entry.label)}</strong> at ${identity(`#${entry.elementId}`)}</li>`)
    .join("");

  const history = value(overview.history);
  const revisions = history?.revisions ?? [];
  byId("workspace-history-content").innerHTML = history
    ? `<p>${escape(revisions.length)} immutable workspace revision(s).</p><ol>${revisions.map((entry) => `<li>${identity(entry.identity ?? entry)}</li>`).join("")}</ol>`
    : `<p>${escape(overview.history?.diagnostic?.message ?? "No workspace history is available yet.")}</p>`;

  const reachability = value(overview.reachability);
  byId("manager-reachability-content").innerHTML = reachability
    ? `<p>Read-only report; destructive: <strong>${escape(reachability.destructive)}</strong>.</p><p>${escape(reachability.generationRoots.length)} retained generation root(s), ${escape(reachability.retainedPackageRoots.length)} retained package root(s), and ${escape(reachability.unreferencedInstalledPackageRoots.length)} unreferenced installed package root(s).</p>`
    : `<p>${escape(overview.reachability?.diagnostic?.message ?? "No reachability report is available.")}</p>`;

  const retained = value(overview.retained)?.generations ?? [];
  byId("retained-generations-content").innerHTML = retained.length
    ? `<p>${escape(retained.length)} retained generation(s).</p><ol>${retained.map((root) => `<li>${identity(root)}</li>`).join("")}</ol>`
    : "<p>No retained generations are currently known.</p>";
}

function renderChoices() {
  const choices = fixture().choice?.options ?? [];
  const container = byId("choice-options");
  const prior = container.querySelector("input:checked")?.value;
  container.innerHTML = choices.map((choice, index) => `<div class="radio-row"><input type="radio" name="replacement-choice" id="replacement-${index}" value="${escape(choice.value)}"><label for="replacement-${index}">${escape(choice.label)} <span class="identity">${escape(choice.value)}</span></label></div>`).join("");
  if (prior) { const restored = [...container.querySelectorAll("input")].find((entry) => entry.value === prior); if (restored) restored.checked = true; }
  byId("generated-request").textContent = JSON.stringify(fixture().generated, null, 2);
}

function renderScenes() {
  const scenes = Object.entries(fixture().scenes ?? {});
  byId("scenes").hidden = scenes.length === 0;
  byId("scene-grid").innerHTML = scenes.map(([key, scene]) => `<figure><img src="/api/scene/${encodeURIComponent(key)}" alt="${escape(scene.alt)}"><figcaption><strong>${escape(scene.label)}</strong><span>${identity(scene.generation)}</span><p>${escape(scene.text)}</p></figcaption></figure>`).join("");
}

function renderLifecycle() {
  const known = packageEntries();
  const currentWorkspace = workspace();
  const plan = latest("workspace.plan");
  const committed = latest("generation.commit")?.generation ?? value(overview.currentGeneration);
  const activeRoot = value(overview.active)?.active?.generation;
  const retainedRoots = new Set(value(overview.retained)?.generations ?? []);
  const selected = new Map((plan?.packages ?? []).map((entry) => [entry.id, entry.root]));
  const staged = new Map();
  for (const operation of currentWorkspace?.revision?.operations ?? []) {
    if (["add", "update"].includes(operation.type)) staged.set(operation.packageRoot, operation.type);
    if (operation.type === "remove") staged.set(operation.packageId, "remove");
  }
  const committedRoots = new Map((committed?.packages ?? []).map((entry) => [entry.id, entry.root]));
  byId("package-rows").innerHTML = known.map((entry) => {
    const states = ["known"];
    if (staged.has(entry.root) || staged.has(entry.id)) states.push(`staged ${staged.get(entry.root) ?? staged.get(entry.id)}`);
    if (selected.get(entry.id) === entry.root) states.push("selected in candidate");
    if (committedRoots.get(entry.id) === entry.root) states.push("committed");
    if (activeRoot === committed?.identity && committedRoots.get(entry.id) === entry.root) states.push("active");
    if (activeRoot && activeRoot !== committed?.identity && committedRoots.get(entry.id) === entry.root) states.push("retired from active generation");
    if (retainedRoots.has(committed?.identity) && committedRoots.get(entry.id) === entry.root) states.push("retained by generation/release/save");
    return `<tr><th scope="row">${escape(entry.id)}</th><td class="identity">${escape(entry.root)}</td><td>${states.map((state) => `<span class="state">${escape(state)}</span>`).join(" ")}</td></tr>`;
  }).join("");
}

function renderWhy() {
  const plan = latest("workspace.plan");
  const explanation = latest("candidate.explain");
  if (!plan && !explanation) return;
  const source = explanation ?? plan;
  const findings = source.findings ?? [];
  const impact = source.impact ?? {};
  byId("why-content").innerHTML = `<p>Candidate ${identity(explanation?.candidate ?? plan?.identity)}</p><p>Status: <strong>${escape(source.status)}</strong>.</p><p>${findings.length} validation/planning finding(s). ${escape((impact.changes ?? []).length)} package change(s) affect ${escape((impact.affected ?? []).length)} causal record(s).</p><ul>${findings.map((finding) => `<li><strong>${escape(finding.severity)}</strong> ${escape(finding.code)} — ${escape(finding.message)}</li>`).join("")}</ul>`;
  byId("impact-text").innerHTML = `<ol>${(impact.affected ?? []).map((entry) => `<li>${escape(entry.kind)} ${identity(entry.id)}<br>Path: ${escape((entry.causalPath ?? []).join(" → "))}</li>`).join("")}</ol><p>Transition class: <strong>${escape(impact.transitionClass ?? "not reported")}</strong>.</p>`;
}

function renderTrace() { byId("trace-result").textContent = JSON.stringify(overview.trace ?? [], null, 2); }
function renderExpertOperations() {
  const operations = overview.clientAuthority?.profiles?.["expert-debug"]?.operations ?? [];
  const select = byId("operation"); const prior = select.value;
  select.innerHTML = operations.map((entry) => `<option>${escape(entry)}</option>`).join("");
  if (operations.includes(prior)) select.value = prior;
}

async function initialise(event) {
  event.preventDefault(); if (inFlight) return; inFlight = true;
  setStatus("initialize-status", "Started portable project initialisation through public operations.");
  try {
    const result = await fetchJson("/api/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      confirmation: byId("project-confirmation").value, surface: "guided", controlId: "initialize-project",
      inputMethod: lastInputMethod,
    }) });
    localLatest["project.initialize"] = result.result;
    setStatus("initialize-status", `Completed portable initialisation with ${result.result.steps.length} public operations.`);
    await loadOverview({ preserveFocus: true }); focusStatus("initialize-status");
  } catch (error) { setStatus("initialize-status", `Initialisation failed. ${error.message}`, true); focusStatus("initialize-status"); }
  finally { inFlight = false; }
}

async function guided(controlId, callback) {
  try { await callback(); }
  catch (error) { if (!error.result) showError(`${controlId} failed: ${error.message}`); }
}

byId("refresh").addEventListener("click", () => loadOverview());
byId("initialize-form").addEventListener("submit", initialise);
byId("import-baseline").addEventListener("click", () => guided("import-baseline", () => runAction("distribution.import", { directory: fixture().baseline.distribution }, { relativePaths: ["directory"], controlId: "import-baseline" })));
byId("activate-baseline").addEventListener("click", () => guided("activate-baseline", () =>
  transition("activate-baseline", "generation.activate", fixture().baseline.generation)));
byId("fork-workspace").addEventListener("click", () => guided("fork-workspace", () => runAction("workspace.import", { source: fixture().baseline.workspace }, { relativePaths: ["source"], controlId: "fork-workspace" })));
byId("import-packages").addEventListener("click", () => guided("import-packages", async () => {
  for (const entry of fixture().imports) await runAction("package.import", { directory: entry.directory, source: entry.source }, { relativePaths: ["directory"], controlId: "import-packages" });
}));
byId("stage-package").addEventListener("click", () => guided("stage-package", () => runAction("workspace.stage", workspaceStage([{ type: "add", packageRoot: packageRoot(fixture().primaryPackage) }]), { controlId: "stage-package" })));
byId("plan-candidate").addEventListener("click", () => guided("plan-candidate", async () => {
  const plan = await runAction("workspace.plan", { name: overview.project.workspace.name, profilePath: fixture().target.profile }, { relativePaths: ["profilePath"], controlId: "plan-candidate" });
  await runAction("candidate.explain", { root: plan.identity }, { controlId: "plan-candidate" });
}));
byId("stage-generated").addEventListener("click", () => guided("stage-generated", () => {
  const configured = fixture().generated;
  const selected = byId("choice-options").querySelector("input:checked");
  if (!selected) throw new Error("Choose one replacement; no option is preselected.");
  const request = { generatorPackageRoot: packageRoot(configured.generatorPackage),
    generatorAction: configured.generatorAction,
    inputPackageRoots: configured.inputPackages.map(packageRoot), inputArtifactRoots: configured.inputArtifactRoots,
    parameters: configured.parameters, environment: configured.environment, packageId: configured.packageId };
  return runAction("workspace.stage", workspaceStage([
    { type: fixture().choice.type, target: fixture().choice.target, replacement: selected.value },
    { type: "add", packageRoot: packageRoot(configured.generatorPackage) },
    { type: "accept-generated", request },
  ]), { controlId: "stage-generated" });
}));
byId("replan-candidate").addEventListener("click", () => guided("replan-candidate", async () => {
  const plan = await runAction("workspace.plan", { name: overview.project.workspace.name,
    profilePath: fixture().target.profile }, { relativePaths: ["profilePath"], controlId: "replan-candidate" });
  await runAction("candidate.explain", { root: plan.identity }, { controlId: "replan-candidate" });
}));
byId("build-candidate").addEventListener("click", () => guided("build-candidate", () => {
  const plan = latest("workspace.plan"); if (!plan) throw new Error("Plan the final candidate first.");
  return runAction("candidate.build", { root: plan.identity }, { controlId: "build-candidate", expectation: "exact-build" });
}));
byId("validate-candidate").addEventListener("click", () => guided("validate-candidate", async () => {
  const build = latest("candidate.build"); if (!build) throw new Error("Build the candidate first.");
  const result = await runAction("candidate.validate", { root: build.identity }, { controlId: "validate-candidate" });
  byId("validation-findings").innerHTML = `<p>Status <strong>${escape(result.status)}</strong>; ${escape(result.acceptedFindings?.length ?? 0)} accepted finding(s). Authority match: <strong>${escape(result.authority?.match)}</strong>.</p>`;
}));
byId("commit-generation").addEventListener("click", () => guided("commit-generation", async () => {
  const validation = latest("candidate.validate"); if (!validation) throw new Error("Validate the candidate first.");
  await runAction("generation.commit", {
    validationRoot: validation.identity,
    expectedGenerationRoot: overview.exactBuild?.expected?.generation ?? fixture().target.generation,
  }, { controlId: "commit-generation", expectation: "exact-build" });
}));
async function transition(controlId, operation, root) { return runAction(operation, { root }, { confirmation: root, controlId }); }
byId("activate-target").addEventListener("click", () => guided("activate-target", () => transition("activate-target", "generation.activate", latest("generation.commit")?.generation?.identity ?? fixture().target.generation)));
byId("rollback-baseline").addEventListener("click", () => guided("rollback-baseline", () => transition("rollback-baseline", "generation.rollback", fixture().baseline.generation)));
byId("reactivate-target").addEventListener("click", () => guided("reactivate-target", () => transition("reactivate-target", "generation.activate", fixture().target.generation)));

byId("stage-root-form").addEventListener("submit", (event) => { event.preventDefault(); guided("stage-root-form", () => {
  const type = byId("stage-root-type").value; const operation = { type, packageRoot: byId("stage-package-root").value };
  if (type === "update") operation.packageId = byId("stage-package-id").value;
  return runAction("workspace.stage", workspaceStage([operation]), { controlId: "stage-root-form" });
}); });
byId("remove-form").addEventListener("submit", (event) => { event.preventDefault(); guided("remove-form", () => runAction("workspace.stage", workspaceStage([{ type: "remove", packageId: byId("remove-package-id").value }]), { controlId: "remove-form" })); });
byId("abandon-form").addEventListener("submit", (event) => { event.preventDefault(); guided("abandon-form", () => runAction("workspace.stage", workspaceStage([{ type: "abandon", operationId: byId("abandon-operation-id").value }]), { controlId: "abandon-form" })); });
byId("selection-form").addEventListener("submit", (event) => { event.preventDefault(); guided("selection-form", () => {
  const type = byId("selection-type").value;
  const fields = {
    "select-provider": ["requirement", "provider"],
    "select-adapter": ["relation", "adapter"],
    "select-replacement": ["target", "replacement"],
  }[type];
  const operation = { type, [fields[0]]: byId("selection-target").value,
    [fields[1]]: byId("selection-value").value };
  return runAction("workspace.stage", workspaceStage([operation]), { controlId: "selection-form" });
}); });

byId("action-form").addEventListener("submit", (event) => { event.preventDefault(); guided("submit-action", async () => {
  let parameters; try { parameters = JSON.parse(byId("parameters").value); } catch (error) { throw new Error(`Parameters are not valid JSON: ${error.message}`); }
  const result = await runAction(byId("operation").value, parameters, { confirmation: byId("confirmation").value,
    controlId: "submit-action", surface: "expert", statusId: "action-status", resultId: "action-result" });
  return result;
}); });

loadOverview();
