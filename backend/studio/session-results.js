
const el = id => document.getElementById(id);
const base = window.ELT_CONFIG.API_BASE;
let offset = 0;
let pageSize = 20;
let pinFromLink = new URLSearchParams(location.search).get("pin");
const status = message => { el("status").textContent = message; };
async function request(path, method = "GET", payload) {
  const response = await fetch(base + path, {
    method, cache: "no-store",
    headers: { Authorization: "Bearer " + el("token").value.trim(), ...(payload ? {"Content-Type":"application/json"} : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : "Request failed (" + response.status + ").");
  }
  return response;
}
function button(label, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.addEventListener("click", action);
  return control;
}
function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function readableDate(value) { return new Date(value).toLocaleString("en-GB", {timeZone:"Asia/Ho_Chi_Minh"}); }
const evidence = window.createEvidenceDetail(el("detail"), request, status);
async function openSession(pin) {
  if (!await evidence.open(pin)) return;
  const url = new URL(location.href);
  url.searchParams.set("pin", pin);
  window.history.replaceState({}, "", url);
}
let historyRequest = 0;
let filters = {};
let deleting = false;
function historyChecks() { return [...el("sessionList").querySelectorAll("input:not(:disabled)")]; }
function updateSelection() {
  const checks = historyChecks();
  const count = checks.filter(input => input.checked).length;
  el("selectPage").disabled = !checks.length || deleting;
  el("selectPage").checked = !!count && count === checks.length;
  el("selectPage").indeterminate = count > 0 && count < checks.length;
  el("deleteSessions").disabled = !count || deleting;
  el("deleteSessions").textContent = count ? "Delete selected (" + count + ")" : "Delete selected";
}
async function loadHistory() {
  const version = ++historyRequest;
  const params = new URLSearchParams({ ...filters, offset: String(offset) });
  const result = await (await request("/session-history?" + params)).json();
  if (version !== historyRequest) return;
  pageSize = result.page_size;
  if (!result.sessions.length && offset > 0) {
    offset = Math.max(0, offset - pageSize);
    return loadHistory();
  }
  el("history").hidden = false;
  el("historyEmpty").hidden = !!result.sessions.length;
  el("previous").disabled = offset === 0;
  el("next").disabled = !result.has_more;
  const currentPage = Math.floor(offset / pageSize) + 1;
  const pages = Array.from({length: result.total_pages}, (_, index) => index + 1);
  el("historyPages").replaceChildren(...pages.map(page => {
    const control = button(String(page), () => {
      offset = (page - 1) * pageSize;
      loadHistory().catch(error => status(error.message));
    });
    control.setAttribute("aria-label", "Page " + page);
    if (page === currentPage) control.setAttribute("aria-current", "page");
    return control;
  }));
  el("sessionList").replaceChildren(...result.sessions.map(session => {
    const row = document.createElement("li");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = session.pin;
    check.disabled = session.status === "active";
    check.setAttribute("aria-label", check.disabled ? "Active session PIN " + session.pin : "Select session PIN " + session.pin);
    check.onchange = updateSelection;
    const open = button(session.title, () => openSession(session.pin).catch(error => status(error.message)));
    open.append(text("small", readableDate(session.created_at) + " · " + session.status + " · PIN " + session.pin));
    row.append(check, open);
    return row;
  }));
  updateSelection();
}
el("toggleFilters").onclick = () => {
  const form = el("historyFilters");
  form.hidden = !form.hidden;
  el("toggleFilters").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) el("historyQuery").focus();
};
function applyFilters() {
  const state = el("historyStatus").value;
  filters = {
    query: el("historyQuery").value.trim(),
    course: el("historyCourse").value.trim(),
    level: el("historyLevel").value.trim(),
    ...(state ? { status: state } : {})
  };
  offset = 0;
  status("");
  loadHistory().catch(error => status(error.message));
}
el("historyFilters").onsubmit = event => { event.preventDefault(); applyFilters(); };
el("clearFilters").onclick = () => { el("historyFilters").reset(); applyFilters(); };
el("selectPage").onchange = event => {
  historyChecks().forEach(input => { input.checked = event.target.checked; });
  updateSelection();
};
let pendingDelete = [];
el("deleteSessions").onclick = () => {
  pendingDelete = historyChecks().filter(input => input.checked).map(input => input.value);
  if (!pendingDelete.length) return;
  el("deleteSessionsSummary").textContent = pendingDelete.length + " selected session(s) · PIN " + pendingDelete.join(", ");
  el("deleteSessionsDialog").returnValue = "";
  el("deleteSessionsDialog").showModal();
};
el("deleteSessionsDialog").onclose = async event => {
  if (event.target.returnValue !== "delete" || deleting || !pendingDelete.length) return;
  const pins = pendingDelete;
  deleting = true;
  updateSelection();
  try {
    const result = await (await request("/session-history/delete", "POST", { pins, confirmation: "DELETE SESSIONS" })).json();
    if (pins.includes(evidence.currentPin())) {
      evidence.clear();
      const url = new URL(location.href);
      url.searchParams.delete("pin");
      window.history.replaceState({}, "", url);
    }
    status("Deleted " + result.deleted + " session(s).");
    await loadHistory();
  } catch (error) {
    status(error.message);
  } finally {
    deleting = false;
    pendingDelete = [];
    updateSelection();
  }
};
el("load").onclick = async () => {
  try {
    status("Loading…");
    await loadHistory();
    if (pinFromLink) { await openSession(pinFromLink); pinFromLink = null; }
    status("");
  } catch (error) { status(error.message); }
};
el("previous").onclick = () => { offset = Math.max(0, offset - pageSize); loadHistory().catch(error => status(error.message)); };
el("next").onclick = () => { offset += pageSize; loadHistory().catch(error => status(error.message)); };
