(() => {
  const el = id => document.getElementById(id);
  const api = window.ELT_CONFIG.API_BASE;
  let profile;
  let reportFilters;
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

  function renderParentNote() {
    const value = el("reportLanguage").value === "vi" ? el("viFeedback").value.trim() : "";
    const note = el("parentNote");
    note.hidden = !value;
    note.replaceChildren();
    if (value) note.append(node("h4", "Nhận xét của giáo viên"), node("p", value));
  }

  function render(data, filters) {
    const vietnamese = el("reportLanguage").value === "vi";
    const label = (english, vietnameseText) => vietnamese ? vietnameseText : english;
    const displayDate = value => vietnamese && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split("-").reverse().join("/") : value;
    el("profile").lang = vietnamese ? "vi" : "en";
    el("reportBrand").textContent = label("Root English House · Learning Progress Report", "Root English House · Báo cáo tiến độ học tập");
    el("summaryTitle").textContent = label("Learning summary", "Tổng quan học tập");
    el("targetsTitle").textContent = label("Progress by Learning Target", "Tiến độ theo mục tiêu học tập");
    el("summaryNote").textContent = label("A task reaches mastery at 80% or higher. Mastery is calculated from scored tasks.",
      "Một bài đạt yêu cầu khi điểm từ 80% trở lên. Tỷ lệ đạt yêu cầu được tính trên các bài đã có điểm.");
    el("print").textContent = label("Print parent report", "In báo cáo phụ huynh");
    el("viFeedbackLabel").hidden = !vietnamese;
    el("profile").hidden = false;
    el("profileName").textContent = data.student.display_name + " · " + data.student.student_id;
    const scopeLabels = vietnamese
      ? {course: "Khóa", level: "Cấp độ", lesson: "Bài học", start: "Từ", end: "Đến"}
      : {course: "Course", level: "Level", lesson: "Lesson", start: "From", end: "To"};
    el("profileScope").textContent = [...filters].map(([key, value]) => scopeLabels[key] + " " + (key === "start" || key === "end" ? displayDate(value) : value)).join(" · ") || label("Full learning history", "Toàn bộ lịch sử học tập");
    const summary = data.summary;
    const metric = (label, value, context, count, maximum) => {
      const card = node("div");
      card.className = "summary-card";
      card.append(node("h4", label), node("strong", value), node("p", context));
      if (maximum > 0) {
        const meter = node("progress");
        meter.max = maximum;
        meter.value = count;
        meter.setAttribute("aria-label", label);
        card.append(meter);
      }
      return card;
    };
    const percent = (count, total) => total ? Math.round(100 * count / total) + "%" : "—";
    const scored = data.records.filter(row => row.score);
    const average = scored.length
      ? Math.round(scored.reduce((sum, row) => sum + row.score.percent, 0) / scored.length) : null;
    el("metrics").replaceChildren(
      metric(label("Sessions", "Số buổi học"), data.sessions.length, label("Sessions in this report", "Số buổi trong kỳ báo cáo")),
      metric(label("Submission rate", "Tỷ lệ nộp bài"), percent(summary.submitted, summary.assigned), label(summary.submitted + " of " + summary.assigned + " tasks submitted", summary.submitted + "/" + summary.assigned + " bài đã nộp"), summary.submitted, summary.assigned),
      metric(label("Average score", "Điểm trung bình"), average == null ? "—" : average + "%", summary.scored + label(" scored tasks", " bài đã có điểm"), average, average == null ? 0 : 100),
      metric(label("Mastery rate", "Tỷ lệ đạt yêu cầu"), percent(summary.mastered, summary.scored), label(summary.mastered + " of " + summary.scored + " scored tasks at 80% or higher", summary.mastered + "/" + summary.scored + " bài đạt từ 80%"), summary.mastered, summary.scored)
    );
    renderParentNote();
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
      const kinds = {multiple_choice: "Trắc nghiệm", writing: "Viết", speaking: "Nói", cloze: "Điền khuyết", short_answer: "Trả lời ngắn", ordering_sentence: "Sắp xếp từ", ordering_paragraph: "Sắp xếp câu"};
      const kind = vietnamese && kinds[row.kind] ? kinds[row.kind] : row.kind.replaceAll("_", " ");
      const key = row.target + " · " + kind;
      if (!targets.has(key)) targets.set(key, []);
      targets.get(key).push(row);
    }
    const targetPanel = el("targets");
    targetPanel.replaceChildren();
    if (!targets.size) targetPanel.append(node("p", label("No scored tasks with a Learning Target in this view.", "Chưa có bài đã chấm gắn với mục tiêu học tập trong kỳ này.")));
    for (const [targetLabel, rows] of targets) {
      const detail = node("details");
      detail.append(node("summary", targetLabel + " · " + rows.length + label(" scored attempts", " lượt có điểm")));
      for (const row of [...rows].reverse()) {
        const point = node("div");
        point.className = "target-point";
        const lessonTitle = row.lesson.replace(/\s+[·–—-]\s+(?:page(?: and ai writing)?|ai writing) test\s*$/i, "");
        const caption = node("span", displayDate(row.date) + " · " + lessonTitle);
        const link = visitLink(row.pin);
        link.classList.add("no-print");
        link.style.marginInlineStart = "0.5em";
        caption.append(link);
        const bar = node("progress");
        bar.max = 100;
        bar.value = row.score.percent;
        bar.setAttribute("aria-label", label("Score: ", "Điểm: ") + row.title);
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
      reportFilters = filters;
      el("viFeedback").value = "";
      render(result, filters);
      status("");
    } catch (error) { if (requestId === version) status(error.message); }
  }
  el("search").onsubmit = event => { event.preventDefault(); void loadProfile(); };
  el("token").oninput = () => { version++; profile = null; el("profile").hidden = true; el("classCodes").replaceChildren(); el("rosterResults").hidden = true; };
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
        const message = await save(Object.fromEntries(new FormData(form)));
        if (profile) await loadProfile();
        status(typeof message === "string" ? message : "Saved.");
      } catch (error) { status(error.message); }
      finally { submit.disabled = false; }
    };
  }
  async function readCsv(file) {
    if (!file?.size || file.size > 500000) throw new Error("Choose a non-empty CSV file under 500 KB.");
    return file.text();
  }
  let rosterOffset = 0;
  async function loadRoster() {
    const code = el("token").value.trim();
    const result = await request("/catalogs/students?offset=" + rosterOffset);
    if (code !== el("token").value.trim()) return;
    const list = el("rosterList");
    list.replaceChildren(...result.rows.map(row => {
      const item = node("li");
      const open = node("button", row.student_id + " · " + row.display_name);
      open.type = "button";
      open.onclick = () => { el("student").value = row.student_id; void loadProfile(); };
      item.append(open, node("span", " · " + row.status));
      return item;
    }));
    if (!result.rows.length) list.append(node("li", "No students found."));
    el("rosterResults").hidden = false;
    el("rosterPrevious").disabled = !rosterOffset;
    el("rosterNext").disabled = !result.has_more;
  }
  function showRoster(offset) {
    rosterOffset = offset;
    loadRoster().catch(error => status(error.message));
  }
  el("loadRoster").onclick = () => showRoster(0);
  el("rosterPrevious").onclick = () => showRoster(Math.max(0, rosterOffset - 500));
  el("rosterNext").onclick = () => showRoster(rosterOffset + 500);
  bind("rosterImport", async ({file}) => {
    const result = await request("/catalogs/students/import", "POST", {csv_text: await readCsv(file)});
    rosterOffset = 0;
    await loadRoster();
    return "Imported or updated " + result.imported + " Student IDs.";
  });
  const updateHeaders = () => {
    el("classImportHeaders").textContent = el("classImportKind").value === "classes"
      ? "Required headers: class_code,course,level"
      : "Required headers: student_id,class_code,started_on,ended_on. Use YYYY-MM-DD; leave ended_on blank for active enrollment.";
  };
  el("classImportKind").onchange = updateHeaders;
  updateHeaders();
  async function downloadLearnerCsv(kind, button) {
    button.disabled = true;
    try {
      const code = el("token").value.trim();
      if (!code) throw new Error("Enter the teacher access code.");
      const response = await fetch(api + "/learner-export/" + kind, {
        headers: {Authorization: "Bearer " + code}, cache: "no-store"
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(typeof result.detail === "string" ? result.detail : "Could not download the CSV.");
      }
      const link = node("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = kind + ".csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      status("Downloaded " + link.download + ".");
    } catch (error) { status(error.message); }
    finally { button.disabled = false; }
  }
  el("exportClasses").onclick = event => void downloadLearnerCsv("classes", event.currentTarget);
  el("exportEnrollments").onclick = event => void downloadLearnerCsv("enrollments", event.currentTarget);

  bind("classImport", async ({kind, file}) => {
    const result = await request("/learner-import/" + kind, "POST", {csv_text: await readCsv(file)});
    await loadClasses();
    return "Processed " + result.imported + " CSV rows.";
  });
  bind("newClass", async data => { await request("/learner-classes", "POST", data); await loadClasses(); });
  bind("enrollment", ({student_id, ended_on, ...data}) =>
    request("/learner-profiles/" + encodeURIComponent(student_id.trim()) + "/enrollment", "PUT", {...data, ended_on: ended_on || null}));
  bind("sessionClass", ({pin, class_code}) => request("/learner-sessions/" + encodeURIComponent(pin) + "/class", "PUT", {class_code}));
  el("reportLanguage").onchange = () => { if (profile) render(profile, reportFilters); };
  el("viFeedback").oninput = () => { if (profile) renderParentNote(); };
  el("print").onclick = () => {
    const closed = [...el("targets").querySelectorAll("details:not([open])")];
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
