
const el = id => document.getElementById(id);
const base = window.ELT_CONFIG.API_BASE;
let offset = 0;
let pageSize = 20;
let current = null;
let pinFromLink = new URLSearchParams(location.search).get("pin");
let archivedPin = null;
const objectUrls = new Set();
const status = message => { el("status").textContent = message; };
function apiPath(pin, suffix = "") { return "/session-history/" + encodeURIComponent(pin) + suffix; }
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
  filters = { query: el("historyQuery").value.trim(), ...(state ? { status: state } : {}) };
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
    if (pins.includes(current?.session.pin)) {
      current = null;
      el("detail").hidden = true;
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
async function openSession(pin) {
  const next = await (await request(apiPath(pin))).json();
  current = next;
  const url = new URL(location.href);
  url.searchParams.set("pin", pin);
  window.history.replaceState({}, "", url);
  el("detail").hidden = false;
  el("sessionTitle").textContent = next.lesson_title;
  el("sessionSummary").textContent = [
    "PIN " + pin, readableDate(next.session.created_at), next.session.status,
    next.lesson_version ? "Lesson version " + next.lesson_version : "", next.joined + " joined"
  ].filter(Boolean).join(" · ");
  const students = new Map(next.tasks.flatMap(task => task.submissions.map(row => [row.student_id, row.student_name])));
  el("studentFilter").replaceChildren(new Option("All students", ""), ...[...students].map(([id,name]) => new Option(name,id)));
  el("deletePanel").hidden = next.session.status === "active" || !next.audio_count;
  el("deleteSummary").textContent = next.audio_count + " recordings · " + (next.audio_bytes / 1048576).toFixed(2) + " MiB. Text responses and reviews are kept.";
  el("verified").checked = false;
  el("confirmation").value = "";
  refreshDelete();
  renderTasks();
}
function renderTasks() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  const filter = el("studentFilter").value;
  el("tasks").replaceChildren(...current.tasks.map((task,index) => {
    const article = document.createElement("article");
    article.append(text("h3", (task.page_task_title || "Task " + (index + 1)) + " · " + task.type.replace("_"," ") + (task.phase ? " · " + task.phase : "")));
    article.append(text("pre", task.prompt));
    if (task.page_index != null) article.append(text("p", "Submitted: " + task.submissions.length + "/" + task.recipient_count));
    const rows = task.submissions.filter(row => !filter || row.student_id === filter);
    article.append(text("p", rows.length + " submission(s)"));
    for (const row of rows) article.append(renderSubmission(task, row, current.session.pin));
    return article;
  }));
}
function renderSubmission(task, row, pin) {
  const panel = document.createElement("details");
  panel.append(text("summary", row.student_name + " · " + readableDate(row.submitted_at)));
  if (task.type === "speaking") {
    if (row.audio_bytes) {
      const play = button("Load recording", async () => {
        play.disabled = true;
        try {
          const response = await request("/sessions/" + pin + "/tasks/" + task.task_id + "/speaking/" + row.student_id);
          if (!panel.isConnected) return;
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.src = URL.createObjectURL(await response.blob());
          objectUrls.add(audio.src);
          play.replaceWith(audio);
        } catch (error) { status(error.message); play.disabled = false; }
      });
      panel.append(play);
    } else panel.append(text("p", "Audio archived"));
  } else {
    panel.append(text("pre", task.questions?.length ? row.selected_option : row.response));
    if (task.questions?.length) panel.append(text("p", "Score: " + row.score + "/" + row.max_score));
  }
  if (!task.questions?.length && task.task_id !== "legacy-writing") panel.append(reviewForm(task, row, pin));
  return panel;
}
function reviewForm(task,row,pin) {
  const form = document.createElement("form");
  form.innerHTML = '<label>Score <input name="score" type="number" min="0" max="100"></label>' +
    '<label>Maximum <input name="maximum" type="number" min="1" max="100"></label>' +
    '<label>Feedback <textarea name="feedback" maxlength="4000"></textarea></label><button>Save review</button><span role="status"></span>';
  const fields = form.elements;
  fields.score.value = row.review_score ?? "";
  fields.maximum.value = row.review_max_score ?? "";
  fields.feedback.value = row.feedback ?? "";
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const save = form.querySelector("button");
    const feedback = form.querySelector("[role=status]");
    save.disabled = true;
    try {
      const review = {score: fields.score.value === "" ? null : Number(fields.score.value),
        max_score: fields.maximum.value === "" ? null : Number(fields.maximum.value), feedback: fields.feedback.value};
      await request(apiPath(pin, "/tasks/" + task.task_id + "/reviews/" + row.student_id), "PUT", review);
      Object.assign(row, {review_score: review.score, review_max_score: review.max_score, feedback: review.feedback});
      feedback.textContent = "Review saved.";
    } catch (error) { feedback.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return form;
}
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
el("studentFilter").onchange = renderTasks;
el("archive").onclick = async () => {
  const pin = current.session.pin;
  el("archive").disabled = true;
  try {
    status("Preparing archive…");
    const response = await request(apiPath(pin, "/archive"));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "session-" + pin + "-evidence.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    archivedPin = pin;
    refreshDelete();
    status("Archive ready. Open the ZIP and check the files before deleting audio.");
  } catch (error) { status(error.message); }
  finally { el("archive").disabled = false; }
};
function refreshDelete() {
  el("deleteAudio").disabled = !current || archivedPin !== current.session.pin ||
    !el("verified").checked || el("confirmation").value !== "DELETE AUDIO";
}
el("verified").onchange = refreshDelete;
el("confirmation").oninput = refreshDelete;
el("deleteAudio").onclick = async () => {
  if (el("deleteAudio").disabled) return;
  el("deleteAudio").disabled = true;
  const pin = current.session.pin;
  try {
    const result = await (await request(apiPath(pin, "/delete-audio"), "POST", {confirmation: "DELETE AUDIO"})).json();
    await openSession(pin);
    status("Deleted " + result.deleted + " recordings (" + (result.audio_bytes / 1048576).toFixed(2) + " MiB).");
  } catch (error) { status(error.message); refreshDelete(); }
};
