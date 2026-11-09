
(() => {
  const code = document.querySelector("[data-target-catalog-code]");
  if (!code) return;
  const list = document.createElement("datalist");
  list.id = "learningTargets";
  document.body.append(list);
  let lastCode = "";
  let requestId = 0;
  async function refresh() {
    const token = code.value.trim();
    if (!token || token === lastCode) return;
    const current = ++requestId;
    const options = [];
    try {
      for (let offset = 0; ; offset += 500) {
        const response = await fetch(window.ELT_CONFIG.API_BASE + "/catalogs/targets?active_only=true&offset=" + offset,
          { headers: { Authorization: "Bearer " + token } });
        if (!response.ok || current !== requestId) return;
        const data = await response.json();
        for (const row of data.rows) options.push(new Option(row.label, row.learning_target_id));
        if (!data.has_more) break;
      }
      if (current !== requestId || code.value.trim() !== token) return;
      list.replaceChildren(...options);
      lastCode = token;
    } catch {
      // Existing saved IDs remain editable if the catalogue cannot be loaded.
    }
  }
  code.addEventListener("change", refresh);
  document.addEventListener("focusin", event => {
    if (event.target.getAttribute("list") === list.id) void refresh();
  });
})();
