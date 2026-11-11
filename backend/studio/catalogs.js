
const el = id => document.getElementById(id);
const columns = ["learning_target_id","label","skill","level","status"];
let offset = 0;
function status(message) { el("status").textContent = message; }
function refreshHeaders() { el("columns").textContent = columns.join(","); }
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
  const result = await request("/catalogs/targets?offset=" + offset);
  const header = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column;
    header.append(cell);
  }
  const body = result.rows.map(row => {
    const item = document.createElement("tr");
    for (const column of columns) {
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
el("file").onchange = async () => {
  const file = el("file").files[0];
  if (!file) return;
  if (file.size > 500000) { status("Use a CSV file under 500 KB."); return; }
  try { el("csv").value = await file.text(); } catch { status("Could not read the CSV file."); }
};
el("import").onclick = async () => {
  el("import").disabled = true;
  try {
    const result = await request("/catalogs/targets/import", {csv_text:el("csv").value});
    offset = 0;
    await load();
    status("Imported or updated " + result.imported + " entries.");
  } catch (error) { status(error.message); }
  finally { el("import").disabled = false; }
};
el("load").onclick = () => { offset = 0; return safeLoad(); };
el("previous").onclick = () => { offset = Math.max(0, offset - 500); return safeLoad(); };
el("next").onclick = () => { offset += 500; return safeLoad(); };
refreshHeaders();
