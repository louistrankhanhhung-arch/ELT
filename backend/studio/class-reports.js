(() => {
  const el = id => document.getElementById(id);
  const node = (tag, text) => {
    const item = document.createElement(tag);
    if (text != null) item.textContent = text;
    return item;
  };
  const token = el("token");
  const status = text => { el("status").textContent = text; };
  const rate = (value, total) => total ? Math.round(value * 100 / total) + "%" : "—";
  let version = 0;

  async function request(path, code) {
    const response = await fetch(window.ELT_CONFIG.API_BASE + path, {
      headers: {Authorization: "Bearer " + code}, cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not load the report.");
    return data;
  }

  function link(path, params, caption) {
    const anchor = node("a", caption);
    anchor.href = path + "?" + new URLSearchParams(params);
    return anchor;
  }

  function table(id, headers, rows) {
    const root = el(id);
    root.replaceChildren();
    if (!rows.length) { root.append(node("p", "No matching records.")); return; }
    const grid = node("table");
    const head = grid.createTHead().insertRow();
    headers.forEach(label => { const th = node("th", label); th.scope = "col"; head.append(th); });
    const body = grid.createTBody();
    for (const row of rows) {
      const line = body.insertRow();
      for (const value of row) {
        const cell = line.insertCell();
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value;
      }
    }
    root.append(grid);
  }

  function sessionLink(session) {
    return link("session-results.html", {pin: session.pin}, session.lesson || "Session " + session.pin);
  }

  function render(data, filters) {
    const info = data.class;
    el("classHeading").textContent = [info.class_code, info.course, info.level].join(" · ");
    const {assigned, submitted, scored, mastered} = data.summary;
    el("metrics").replaceChildren(...[
      ["Sessions", data.sessions.length, "Matching sessions"],
      ["Submission rate", rate(submitted, assigned), submitted + "/" + assigned + " submitted"],
      ["Mastery rate", rate(mastered, scored), mastered + "/" + scored + " scored tasks reached mastery"]
    ].map(([title, value, detail]) => {
      const card = node("article");
      card.append(node("span", title), node("strong", value), node("small", detail));
      return card;
    }));

    table("targets", ["Learning Target", "Task type", "Mastery", "Students scored", "Evidence"], data.targets.map(row => {
      const result = node("div", row.mastered + "/" + row.scored + " · " + rate(row.mastered, row.scored));
      if (row.scored) {
        const meter = node("progress");
        meter.max = row.scored;
        meter.value = row.mastered;
        meter.setAttribute("aria-label", "Mastery for " + row.target);
        result.append(node("br"), meter);
      }
      const evidence = node("details");
      evidence.append(node("summary", row.sessions.length + " sessions"),
        ...row.sessions.map(session => sessionLink(session)));
      return [row.target, row.kind.replaceAll("_", " "), result, row.learner_count, evidence];
    }));

    table("students", ["Student", "Submitted", "Mastery", "Latest score", "Progress signal"], data.learners.map(row => {
      const profileFilters = {student: row.student_id, course: info.course, level: info.level};
      for (const key of ["start", "end", "lesson"]) if (filters.has(key)) profileFilters[key] = filters.get(key);
      const learner = row.student_id
        ? link("learner-profiles.html", profileFilters, row.name + " · " + row.student_id) : row.name;
      const latest = row.latest ? sessionLink(row.latest) : "—";
      if (row.latest) latest.textContent = row.latest.percent + "% · " + row.latest.date;
      const signal = row.signal ? node("details") : "—";
      if (row.signal) {
        signal.append(node("summary", row.signal.status + " · " + (row.signal.change > 0 ? "+" : "") + row.signal.change + " pp"),
          ...row.signal.pins.map(pin => sessionLink({pin})));
      }
      return [learner, row.submitted + "/" + row.assigned, row.mastered + "/" + row.scored, latest, signal];
    }));

    table("sessions", ["Date", "Lesson", "Submitted", "Mastery"], data.sessions.map(session =>
      [session.date, sessionLink(session), session.submitted + "/" + session.assigned, session.mastered + "/" + session.scored]));
    el("report").hidden = false;
  }

  token.addEventListener("input", () => {
    version++;
    el("report").hidden = true;
    el("classCodes").replaceChildren();
    status("");
  });
  token.addEventListener("change", async () => {
    const code = token.value.trim();
    if (!code) return;
    try {
      const result = await request("/learner-classes", code);
      if (code === token.value.trim()) el("classCodes").replaceChildren(...result.classes.map(item =>
        new Option(item.course + " " + item.level, item.class_code)));
    } catch (error) { if (code === token.value.trim()) status(error.message); }
  });
  el("filters").onsubmit = async event => {
    event.preventDefault();
    const id = ++version;
    const data = new FormData(event.currentTarget);
    const classCode = data.get("class_code").trim();
    const filters = new URLSearchParams();
    for (const key of ["start", "end", "lesson", "target"]) {
      const value = data.get(key).trim();
      if (value) filters.set(key, value);
    }
    el("report").hidden = true;
    status("Loading class report…");
    try {
      const report = await request("/class-reports/" + encodeURIComponent(classCode) + "?" + filters, token.value.trim());
      if (id !== version) return;
      render(report, filters);
      status("");
    } catch (error) { if (id === version) status(error.message); }
  };
})();
