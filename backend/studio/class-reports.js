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

  const sourceName = source => ({classroom: "Classroom", homework: "Homework", test: "Test"})[source] || "Classroom";
  const submittedCount = stats => stats ? stats.submitted + "/" + stats.assigned : "—";

  function learnerEvidence(row, filters, classCode) {
    const details = node("details");
    const body = node("div");
    details.append(node("summary", "View student work"), body);
    let loaded = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded) return;
      loaded = true;
      body.textContent = "Loading student work…";
      const id = version;
      const code = token.value.trim();
      const params = new URLSearchParams(filters);
      params.set("learner", row.key);
      try {
        const data = await request("/class-reports/" + encodeURIComponent(classCode) + "?" + params, code);
        if (id !== version) return;
        const cards = data.records.map(record => {
          const card = node("details");
          card.append(node("summary", [sourceName(record.source), record.date, record.lesson, record.title,
            record.score ? record.score.points + "/" + record.score.maximum : record.status].join(" · ")));
          if (record.target) card.append(node("p", record.target));
          if (record.prompt && record.prompt !== record.title) card.append(node("p", record.prompt));
          if (record.items.length) {
            const list = node("ol");
            for (const item of record.items) {
              const answer = item.selected_text ?? item.selected_option ?? item.response ?? item.answer;
              if (answer != null) list.append(node("li", (item.prompt || item.question_id || "") + " · " + answer));
            }
            if (list.children.length) card.append(list);
          }
          if (record.response && !record.items.length && !record.audio_member) card.append(node("pre", record.response));
          if (record.feedback) card.append(node("p", record.feedback));
          if (record.audio_member) {
            const play = node("button", "Load recording");
            play.type = "button";
            play.onclick = async () => {
              play.disabled = true;
              const key = encodeURIComponent;
              try {
                const response = await fetch(window.ELT_CONFIG.API_BASE +
                  "/sessions/" + key(record.pin) + "/tasks/" + key(record.task_id) + "/speaking/" + key(record.audio_member),
                  {headers: {Authorization: "Bearer " + code}, cache: "no-store"});
                if (!response.ok) throw new Error("Could not load the recording.");
                const blob = await response.blob();
                if (!play.isConnected || id !== version) return;
                const audio = node("audio");
                audio.controls = true;
                audio.src = URL.createObjectURL(blob);
                audio.dataset.evidenceAudio = audio.src;
                play.replaceWith(audio);
              } catch (error) {
                play.disabled = false;
                play.textContent = error.message + " Retry";
              }
            };
            card.append(play);
          }
          return card;
        });
        body.replaceChildren(...(cards.length ? cards : [node("p", "No matching student work.")]));
      } catch (error) {
        loaded = false;
        body.textContent = error.message;
      }
    });
    return details;
  }

  function clearAudio() {
    for (const audio of el("students").querySelectorAll("[data-evidence-audio]")) {
      audio.pause();
      URL.revokeObjectURL(audio.dataset.evidenceAudio);
      audio.remove();
    }
  }

  function render(data, filters) {
    const info = data.class;
    el("classHeading").textContent = [info.class_code, info.course, info.level].join(" · ");
    const {assigned, submitted, scored, mastered} = data.summary;
    el("metrics").replaceChildren(...[
      ["Classroom sessions", data.sessions.filter(row => row.source === "classroom").length, "Matching classroom sessions"],
      ["Homework", data.sessions.filter(row => row.source === "homework").length, "Matching homework assignments"],
      ["Submission rate", rate(submitted, assigned), submitted + "/" + assigned + " submitted"],
      ["Mastery rate", rate(mastered, scored), mastered + "/" + scored + " scored tasks reached mastery"]
    ].map(([title, value, detail]) => {
      const card = node("article");
      card.append(node("span", title), node("strong", value), node("small", detail));
      return card;
    }));

    table("lessons", ["Lesson", "Classroom submitted", "Homework submitted", "Test submitted"], data.lessons.map(row => {
      const select = node("button", row.title);
      select.type = "button";
      select.onclick = () => {
        el("filters").elements.lesson.value = row.key;
        el("filters").requestSubmit();
      };
      return [select, submittedCount(row.sources.classroom), submittedCount(row.sources.homework), submittedCount(row.sources.test)];
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

    table("students", ["Student", "Submitted", "Mastery", "Latest score", "Progress signal", "Evidence"], data.learners.map(row => {
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
      return [learner, row.submitted + "/" + row.assigned, row.mastered + "/" + row.scored, latest, signal, learnerEvidence(row, filters, info.class_code)];
    }));

    table("sessions", ["Date", "Lesson", "Source", "Submitted", "Mastery"], data.sessions.map(session =>
      [session.date, sessionLink(session), sourceName(session.source), session.submitted + "/" + session.assigned, session.mastered + "/" + session.scored]));
    el("report").hidden = false;
  }

  token.addEventListener("input", () => {
    version++;
    clearAudio();
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
    clearAudio();
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
