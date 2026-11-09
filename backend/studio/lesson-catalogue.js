
const el = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const revision = params.get("revision");
let catalogueId = params.get("catalogue");
let entry = null;
let offset = 0;
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
async function loadList() {
  const result = await request("/lesson-catalogue?" + new URLSearchParams({search:el("query").value, offset}));
  el("results").hidden = false;
  el("previous").disabled = offset === 0;
  el("next").disabled = !result.has_more;
  el("entries").replaceChildren(...result.entries.map(item => {
    const row = document.createElement("article");
    row.append(node("h3", item.title), node("p", [item.level, item.cluster, "Version " + item.version].join(" · ")));
    row.append(lessonLink("Open Classroom", "teacher.html", {lesson:"imports/" + item.revision_id, catalogue:item.catalogue_id}));
    if (item.origin === "work") row.append(lessonLink("Edit in Studio", "author.html",
      {revision:item.revision_id, catalogue:item.catalogue_id}));
    return row;
  }));
  if (!result.entries.length) el("entries").append(node("p", "No matching lessons."));
}
async function loadPublishForm() {
  if (!revision) return;
  const form = el("publishForm").elements;
  if (catalogueId && !entry) {
    entry = await request("/lesson-catalogue/" + encodeURIComponent(catalogueId));
    for (const key of ["title","level","cluster"]) form[key].value = entry[key];
  }
}
el("searchForm").onsubmit = async event => {
  event.preventDefault();
  offset = 0;
  try { await loadList(); await loadPublishForm(); status(""); }
  catch (error) { status(error.message); }
};
function turnPage(step) {
  offset = Math.max(0, offset + step);
  loadList().catch(error => status(error.message));
}
el("previous").onclick = () => turnPage(-50);
el("next").onclick = () => turnPage(50);
if (/^[a-f0-9]{32}$/.test(revision || "")) {
  el("publishPanel").hidden = false;
  el("revisionInfo").textContent = "This action publishes the selected saved version.";
  if (catalogueId) {
    el("publishTitle").textContent = "Publish new version";
    el("publishButton").textContent = "Publish new version";
    el("token").addEventListener("change", () => loadPublishForm().catch(error => status(error.message)));
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
    const form = el("publishForm").elements;
    const payload = {revision_id:revision, title:form.title.value.trim(), level:form.level.value.trim(), cluster:form.cluster.value.trim()};
    const result = catalogueId
      ? await request("/lesson-catalogue/" + encodeURIComponent(catalogueId), "PUT", {...payload, expected_revision:entry.revision_id})
      : await request("/lesson-catalogue", "POST", payload);
    el("publishPanel").hidden = true;
    el("query").value = result.title;
    offset = 0;
    const url = new URL(location.href);
    url.search = "";
    window.history.replaceState({}, "", url);
    await loadList();
    status("Version " + result.version + " published in the catalogue.");
  } catch (error) { status(error.message); }
  finally { button.disabled = false; }
};
