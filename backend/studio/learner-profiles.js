(() => {
  const el = id => document.getElementById(id);
  const api = window.ELT_CONFIG.API_BASE;
  let profile;
  let version = 0;
  const status = value => { el("status").textContent = value; };
  const node = (tag, value) => {
    const item = document.createElement(tag);
    if (value != null) item.textContent = value;
    return item;
  };
  async function request(path, method = "GET", body) {
    const code = el("token").value.trim();
    if (!code) throw new Error("Enter the teacher access code.");
    const response = await fetch(api + path, {
      method, cache: "no-store",
      headers: {Authorization: "Bearer " + code, ...(body ? {"Content-Type":"application/json"} : {})},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Check the entered values.");
    return data;
  }

  function visitLink(pin) {
    const link = node("a", "Session " + pin);
    link.href = "session-results.html?pin=" + encodeURIComponent(pin);
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }

  function render(data, filters) {
    el("profile").hidden = false;
    el("profileName").textContent = data.student.display_name + " · " + data.student.student_id;
    el("profileScope").textContent = [...filters].map(([key, value]) => key + " " + value).join(" · ") || "Full learning history";
    const summary = data.summary;
    el("metrics").replaceChildren(...[
      data.sessions.length + " sessions", summary.submitted + "/" + summary.assigned + " submitted",
      summary.scored + " scored", summary.mastered + "/" + summary.scored + " reached mastery"
    ].map(value => node("span", value)));
    const signals = el("signals");
    signals.replaceChildren(node("h4", "Progress signals"));
    if (!data.signals.length) signals.append(node("p", "No signal detected. Signals need three scored attempts on the same prepared task in the same lesson version."));
    for (const signal of data.signals) {
      const item = node("details");
      item.append(node("summary", signal.status + " · " + (signal.change > 0 ? "+" : "") + signal.change + " percentage points · " + signal.evidence[0].title));
      const list = node("ul");
      for (const row of signal.evidence) {
        const entry = node("li", row.date + " · " + row.score.percent + "% · ");
        entry.append(visitLink(row.pin));
        list.append(entry);
      }
      item.append(list);
      signals.append(item);
    }
    el("enrollments").replaceChildren(...data.enrollments.map(item => node("li",
      [item.class_code, item.course + " " + item.level, item.started_on + " to " + (item.ended_on || "present")].join(" · "))));
    if (!data.enrollments.length) el("enrollments").append(node("li", "No enrollment dates recorded."));
    const targets = new Map();
    for (const row of data.records) {
      if (!row.target || !row.score) continue;
      const key = row.target + " · " + row.kind.replaceAll("_", " ");
      if (!targets.has(key)) targets.set(key, []);
      targets.get(key).push(row);
    }
    const targetPanel = el("targets");
    targetPanel.replaceChildren();
    if (!targets.size) targetPanel.append(node("p", "No scored tasks with a Learning Target in this view."));
    for (const [label, rows] of targets) {
      const detail = node("details");
      detail.append(node("summary", label + " · " + rows.length + " scored attempts"));
      for (const row of [...rows].reverse()) {
        const point = node("div");
        point.className = "target-point";
        const caption = node("span", row.date + " · " + row.lesson + " · ");
        caption.append(visitLink(row.pin));
        const bar = node("progress");
        bar.max = 100;
        bar.value = row.score.percent;
        bar.setAttribute("aria-label", row.title + " score");
        point.append(caption, bar, node("strong", row.score.percent + "%"));
        detail.append(point);
      }
      targetPanel.append(detail);
    }
    const visits = el("visits");
    visits.replaceChildren();
    if (!data.sessions.length) visits.append(node("p", "No sessions match these filters."));
    const bySession = new Map(data.sessions.map(item => [item.pin, []]));
    data.records.forEach(row => bySession.get(row.pin)?.push(row));
    for (const session of data.sessions) {
      const detail = node("details");
      detail.append(node("summary", [session.date, session.lesson, session.class_code || "Class unrecorded", [session.course, session.level].filter(Boolean).join(" ")].filter(Boolean).join(" · ")), visitLink(session.pin));
      const records = bySession.get(session.pin);
      if (!records.length) detail.append(node("p", "No task records for this session."));
      else {
        const wrap = node("div");
        wrap.className = "table";
        const table = node("table");
        const header = node("tr");
        for (const heading of ["Task / Learning Target", "Result", "Class median", "Feedback"]) header.append(node("th", heading));
        const head = node("thead");
        head.append(header);
        table.append(head);
        const body = node("tbody");
        for (const row of records) {
          const line = node("tr");
          const title = node("td", row.title);
          if (row.target) title.append(node("small", row.target));
          line.append(title,
            node("td", row.score ? row.score.points + "/" + row.score.maximum + " · " + row.score.percent + "%" : row.status),
            node("td", row.class_median == null ? "—" : row.class_median + "% · " + row.peer_count + " peers"),
            node("td", row.feedback || "—"));
          body.append(line);
        }
        table.append(body);
        wrap.append(table);
        detail.append(wrap);
      }
      visits.append(detail);
    }
  }

  async function loadProfile() {
    const requestId = ++version;
    const filters = new URLSearchParams();
    for (const key of ["course", "level", "lesson", "start", "end"]) if (el(key).value.trim()) filters.set(key, el(key).value.trim());
    profile = null;
    el("profile").hidden = true;
    status("Loading profile…");
    try {
      const result = await request("/learner-profiles/" + encodeURIComponent(el("student").value.trim()) + "?" + filters);
      if (requestId !== version) return;
      profile = result;
      render(result, filters);
      status("");
    } catch (error) { if (requestId === version) status(error.message); }
  }
  el("search").onsubmit = event => { event.preventDefault(); void loadProfile(); };
  el("token").oninput = () => { version++; profile = null; el("profile").hidden = true; el("classCodes").replaceChildren(); };
  async function loadClasses() {
    const result = await request("/learner-classes");
    el("classCodes").replaceChildren(...result.classes.map(item => new Option(item.course + " " + item.level, item.class_code)));
  }
  el("token").onchange = () => { if (el("token").value.trim()) loadClasses().catch(error => status(error.message)); };
  function bind(id, save) {
    el(id).onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector("button");
      submit.disabled = true;
      try {
        await save(Object.fromEntries(new FormData(form)));
        if (profile) await loadProfile();
        status("Saved.");
      } catch (error) { status(error.message); }
      finally { submit.disabled = false; }
    };
  }
  bind("newClass", async data => { await request("/learner-classes", "POST", data); await loadClasses(); });
  bind("enrollment", ({student_id, ended_on, ...data}) =>
    request("/learner-profiles/" + encodeURIComponent(student_id.trim()) + "/enrollment", "PUT", {...data, ended_on: ended_on || null}));
  bind("sessionClass", ({pin, class_code}) => request("/learner-sessions/" + encodeURIComponent(pin) + "/class", "PUT", {class_code}));
  el("print").onclick = () => {
    const closed = [...el("profile").querySelectorAll("details:not([open])")];
    closed.forEach(item => { item.open = true; });
    window.print();
    closed.forEach(item => { item.open = false; });
  };
  el("export").onclick = () => {
    if (!profile) return;
    const cell = value => {
      let text = String(value ?? "");
      if (/^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const rows = [["Student ID","Date","Session","Class","Course","Level","Lesson","Version","Task","Learning Target","Status","Score","Maximum","Class median","Peers","Feedback"],
      ...profile.records.map(row => [profile.student.student_id,row.date,row.pin,row.class_code,row.course,row.level,row.lesson,row.lesson_version,row.title,row.target,row.status,row.score?.points,row.score?.maximum,row.class_median,row.peer_count,row.feedback])];
    const link = node("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + rows.map(row => row.map(cell).join(",")).join("\r\n")], {type:"text/csv;charset=utf-8"}));
    link.download = "learner-" + profile.student.student_id.replace(/[^a-z0-9_-]/gi, "_") + ".csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
})();
