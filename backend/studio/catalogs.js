
const el = id => document.getElementById(id);
const columns = {students:["student_id","display_name","status"],targets:["learning_target_id","label","skill","level","status"]};
let offset = 0;
function status(message) { el("status").textContent = message; }
function refreshHeaders() { el("columns").textContent = columns[el("kind").value].join(","); }
async function request(path, payload) {
  const response = await fetch(window.ELT_CONFIG.API_BASE + path, {
    method: payload ? "POST" : "GET", cache: "no-store",
    headers: { Authorization: "Bearer " + el("token").value.trim(), ...(payload ? {"Content-Type":"application/json"} : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Check the CSV format and size.");
  return result;
}
async function load() {
  const kind = el("kind").value;
  const result = await request("/catalogs/" + kind + "?offset=" + offset);
  if (kind !== el("kind").value) return;
  const header = document.createElement("tr");
  for (const column of columns[kind]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column;
    header.append(cell);
  }
  const body = result.rows.map(row => {
    const item = document.createElement("tr");
    for (const column of columns[kind]) {
      const cell = document.createElement("td");
      cell.textContent = row[column];
      item.append(cell);
    }
    return item;
  });
  el("table").replaceChildren(header, ...body);
  el("results").hidden = false;
  el("previous").disabled = offset === 0;
  el("next").disabled = !result.has_more;
  status(result.rows.length ? "Catalogue loaded." : "No entries yet.");
}
function safeLoad() { return load().catch(error => status(error.message)); }
el("kind").onchange = () => {
  refreshHeaders();
  offset = 0;
  el("results").hidden = true;
  el("file").value = "";
  el("csv").value = "";
  status("");
};
el("file").onchange = async () => {
  const file = el("file").files[0];
  if (!file) return;
  if (file.size > 500000) { status("Use a CSV file under 500 KB."); return; }
  try { el("csv").value = await file.text(); } catch { status("Could not read the CSV file."); }
};
el("import").onclick = async () => {
  const kind = el("kind").value;
  el("import").disabled = true;
  try {
    const result = await request("/catalogs/" + kind + "/import", {csv_text:el("csv").value});
    offset = 0;
    if (kind === el("kind").value) await load();
    status("Imported or updated " + result.imported + " entries.");
  } catch (error) { status(error.message); }
  finally { el("import").disabled = false; }
};
el("load").onclick = () => { offset = 0; return safeLoad(); };
el("previous").onclick = () => { offset = Math.max(0, offset - 500); return safeLoad(); };
el("next").onclick = () => { offset += 500; return safeLoad(); };
refreshHeaders();
