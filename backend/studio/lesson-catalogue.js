
const el = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const revision = params.get("revision");
let catalogueId = params.get("catalogue");
let entry = null;
let entries = [];
let generation = 0;
let unlockTimer = null;
const api = window.ELT_CONFIG.API_BASE;
function status(value) { el("status").textContent = value; }
async function request(path, method = "GET", payload) {
  const response = await fetch(api + path, {
    method, cache: "no-store",
    headers: { Authorization: "Bearer " + el("token").value.trim(), ...(payload ? {"Content-Type":"application/json"} : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Could not complete the request.");
  return result;
}
function node(tag, label) { const item = document.createElement(tag); item.textContent = label; return item; }
function lessonLink(label, page, values) {
  const link = node("a", label);
  link.className = "action";
  link.href = page + "?" + new URLSearchParams(values);
  return link;
}
const metadataFields = [
  ["course","Course",160], ["title","Lesson title",160], ["level","Level",80], ["cluster","Cluster",120]
];

function metadata(form) {
  return Object.fromEntries(metadataFields.map(([key]) => [key, form.elements[key].value.trim()]));
}

function metadataEditor(item) {
  const details = document.createElement("details");
  details.append(node("summary", "Edit catalogue details"));
  const form = document.createElement("form");
  for (const [key,label,maxLength] of metadataFields) {
    const field = node("label", label);
    const input = document.createElement("input");
    input.name = key;
    input.value = key === "course" && item.course === "Unassigned course" ? "" : item[key];
    input.maxLength = maxLength;
    input.required = true;
    if (key === "course") input.setAttribute("list","courseNames");
    field.append(input);
    form.append(field);
  }
  const button = node("button", "Save catalogue details");
  const feedback = node("p", "");
  feedback.setAttribute("role","status");
  form.append(button, feedback);
  form.onsubmit = async event => {
    event.preventDefault();
    button.disabled = true;
    const current = generation;
    try {
      const updated = await request("/lesson-catalogue/" + encodeURIComponent(item.catalogue_id), "PATCH", metadata(form));
      if (current !== generation) return;
      entries = entries.map(entry => entry.catalogue_id === updated.catalogue_id ? updated : entry);
      updateCourses();
      renderList();
      status("Catalogue details saved.");
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  };
  details.append(form);
  return details;
}

function updateCourses() {
  const courses = [...new Set(entries.map(item => item.course).filter(course => course && course !== "Unassigned course"))].sort();
  el("courseNames").replaceChildren(...courses.map(course => new Option(course)));
}

function renderList() {
  const search = el("query").value.trim().toLocaleLowerCase();
  const matching = entries.filter(item => [item.title,item.course,item.level,item.cluster]
    .some(value => (value || "").toLocaleLowerCase().includes(search)));
  const courses = new Map();
  for (const item of matching) {
    const course = item.course || "Unassigned course";
    if (!courses.has(course)) courses.set(course, new Map());
    const levels = courses.get(course);
    if (!levels.has(item.level)) levels.set(item.level, []);
    levels.get(item.level).push(item);
  }
  const output = el("entries");
  output.replaceChildren();
  const sorted = map => [...map.entries()].sort(([a],[b]) => a.localeCompare(b, undefined, {numeric:true}));
  for (const [course,levels] of sorted(courses)) {
    const group = document.createElement("div");
    group.className = "course-group";
    group.append(node("h3",course));
    for (const [level,lessons] of sorted(levels)) {
      const subgroup = document.createElement("div");
      subgroup.className = "level-group";
      subgroup.append(node("h4",level));
      for (const item of lessons.sort((a,b) => a.title.localeCompare(b.title, undefined, {numeric:true}))) {
        const row = document.createElement("article");
        row.append(node("h5",item.title), node("p",[item.cluster,"Version " + item.version].join(" · ")));
        row.append(lessonLink("Open Classroom", "teacher.html", {lesson:"imports/" + item.revision_id, catalogue:item.catalogue_id}));
        if (item.origin === "work") row.append(lessonLink("Edit in Studio", "author.html",
          {revision:item.revision_id, catalogue:item.catalogue_id}));
        row.append(metadataEditor(item));
        subgroup.append(row);
      }
      group.append(subgroup);
    }
    output.append(group);
  }
  if (!matching.length) output.append(node("p", entries.length ? "No matching lessons." : "No published lessons yet."));
}

async function loadList() {
  clearTimeout(unlockTimer);
  const token = el("token").value.trim();
  if (!token) return;
  const current = ++generation;
  status("Loading catalogue…");
  const found = new Map();
  try {
    for (let offset = 0; ; offset += 50) {
      const result = await request("/lesson-catalogue?offset=" + offset);
      if (current !== generation || token !== el("token").value.trim()) return;
      for (const item of result.entries) found.set(item.catalogue_id,item);
      if (!result.has_more) break;
    }
    entries = [...found.values()];
    updateCourses();
    renderList();
    el("results").hidden = false;
    el("filterLabel").hidden = false;
    await loadPublishForm();
    if (current === generation) status("");
  } catch (error) {
    if (current === generation) status(error.message);
  }
}

async function loadPublishForm() {
  if (!revision || !catalogueId || entry) return;
  const loaded = await request("/lesson-catalogue/" + encodeURIComponent(catalogueId));
  entry = loaded;
  for (const [key] of metadataFields) {
    el("publishForm").elements[key].value = key === "course" && loaded.course === "Unassigned course" ? "" : loaded[key];
  }
}

el("query").addEventListener("input", renderList);
el("openCatalogue").onclick = loadList;
el("token").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); void loadList(); }
});
el("token").addEventListener("input", () => {
  clearTimeout(unlockTimer);
  generation++;
  entries = [];
  entry = null;
  el("results").hidden = true;
  el("filterLabel").hidden = true;
  el("entries").replaceChildren();
  el("courseNames").replaceChildren();
  status("");
  if (el("token").value.trim()) unlockTimer = setTimeout(loadList, 650);
});
if (/^[a-f0-9]{32}$/.test(revision || "")) {
  el("publishPanel").hidden = false;
  el("revisionInfo").textContent = "This action publishes the selected saved version.";
  if (catalogueId) {
    el("publishTitle").textContent = "Publish new version";
    el("publishButton").textContent = "Publish new version";

  } else {
    fetch(api + "/imports/" + revision).then(response => response.ok ? response.json() : null).then(lesson => {
      if (lesson && !el("publishForm").elements.title.value) el("publishForm").elements.title.value = lesson.title;
    }).catch(() => {});
  }
}
el("publishForm").onsubmit = async event => {
  event.preventDefault();
  const button = el("publishButton");
  button.disabled = true;
  try {
    await loadPublishForm();
    const payload = {revision_id:revision, ...metadata(el("publishForm"))};
    const result = catalogueId
      ? await request("/lesson-catalogue/" + encodeURIComponent(catalogueId), "PUT", {...payload, expected_revision:entry.revision_id})
      : await request("/lesson-catalogue", "POST", payload);
    el("publishPanel").hidden = true;
    el("query").value = "";
    const url = new URL(location.href);
    url.search = "";
    window.history.replaceState({}, "", url);
    await loadList();
    status("Version " + result.version + " published in the catalogue.");
  } catch (error) { status(error.message); }
  finally { button.disabled = false; }
};
