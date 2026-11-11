(() => {
  const el = id => document.getElementById(id);
  const api = window.ELT_CONFIG.API_BASE;
  const params = new URLSearchParams(location.search);
  const legacyLink = new URLSearchParams(location.hash.slice(1)).has("access");
  const studentMode = params.get("join") === "1" || legacyLink;
  let access = null;
  const vietnamTime = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short"
  });
  const showDue = value => vietnamTime.format(new Date(value));
  const toInput = value => showDue(value).replace(" ", "T");
  const duePayload = id => el(id).value + ":00+07:00";
  const screenUrl = pin => "join-screen.html?homework=1&pin=" + encodeURIComponent(pin);
  const state = {lessons: [], offset: 0};
  const node = (tag, text) => {
    const item = document.createElement(tag);
    if (text != null) item.textContent = text;
    return item;
  };
  const status = value => { el("status").textContent = value; };
  const button = (name, handler) => {
    const item = node("button", name);
    item.type = "button";
    item.onclick = handler;
    return item;
  };
  async function request(path, payload) {
    const code = studentMode ? access : el("token").value.trim();
    const response = await fetch(api + path, {
      method: payload === undefined ? "GET" : "POST", cache: "no-store",
      headers: {...(code ? {Authorization: "Bearer " + code} : {}), ...(payload === undefined ? {} : {"Content-Type":"application/json"})},
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Check the entered values.");
    return result;
  }
  function check(value, text) {
    const label = node("label");
    const input = node("input");
    input.type = "checkbox";
    input.value = value;
    label.append(input, " " + text);
    return label;
  }
  const checked = id => [...el(id).querySelectorAll("input:checked")].map(item => item.value);

  async function loadBlocks() {
    const id = el("lesson").value;
    el("blocks").replaceChildren();
    const entry = state.lessons.find(item => item.catalogue_id === id);
    if (!entry) return;
    const lesson = await request("/imports/" + entry.revision_id);
    if (el("lesson").value !== id) return;
    for (const block of lesson.blocks) {
      if (block.dialogue) continue;
      el("blocks").append(check(block.id, block.title + (block.page_tasks ? " · review content" : "")));
      for (const task of block.page_tasks || []) el("blocks").append(check(block.id + ":" + task.id, "Task · " + task.title));
    }
  }
  async function loadRecipients() {
    const code = el("classCode").value;
    el("recipients").replaceChildren();
    if (!code) return;
    const result = await request("/homework/roster/" + encodeURIComponent(code));
    if (el("classCode").value !== code) return;
    el("recipients").replaceChildren(...result.students.map(item => check(item.student_id, item.display_name + " · " + item.student_id)));
    if (!result.students.length) el("recipients").append(node("p", "No active students enrolled in this class."));
  }
  async function showReport(item) {
    const report = await request("/homework/" + encodeURIComponent(item.pin) + "/report");
    el("report").hidden = false;
    el("reportTitle").textContent = item.title;
    el("reportCount").textContent = report.recipients.length + " assigned · " + report.tasks.length + " tasks";
    el("evidence").href = "session-results.html?pin=" + encodeURIComponent(item.pin);
    renderSchedule(item, report);
    el("links").replaceChildren(...report.recipients.map(learner => {
      const submitted = report.tasks.filter(task => task.submissions.some(answer => answer.student_id === learner.student_id)).length;
      return node("p", learner.student_name + " · " + learner.roster_id + " · " + submitted + "/" + report.tasks.length + " submitted");
    }));
  }
  function renderSchedule(item, schedule) {
    const open = schedule.status === "open";
    const label = {open: "Open", ended: "Ended early", overdue: "Deadline passed"}[schedule.status];
    el("scheduleStatus").textContent = label + " · Due " + showDue(schedule.due_at) + " (Vietnam time)";
    el("newDue").value = open ? toInput(schedule.due_at) : "";
    el("homeworkScreen").onclick = () => window.open(screenUrl(schedule.join_pin), "_blank", "noopener");
    el("endHomework").hidden = !open;
    el("scheduleAction").textContent = open ? "Extend deadline" : "Reopen homework";
    const update = async (action, due_at) => {
      el("scheduleAction").disabled = el("endHomework").disabled = true;
      try {
        const next = await request("/homework/" + encodeURIComponent(item.pin) + "/schedule", {action, due_at});
        renderSchedule(item, next);
        status(action === "end" ? "Homework ended." : action === "extend" ? "Deadline extended." : "Homework reopened.");
        await loadAssignments(true);
      } finally {
        el("scheduleAction").disabled = el("endHomework").disabled = false;
      }
    };
    el("endHomework").onclick = () => {
      if (window.confirm("End homework now? Students can still review submitted answers.")) {
        void run(() => update("end"));
      }
    };
    el("schedule").onsubmit = event => {
      event.preventDefault();
      void run(() => update(open ? "extend" : "reopen", duePayload("newDue")));
    };
  }
  async function loadAssignments(reset = false) {
    if (reset) { state.offset = 0; el("assignments").replaceChildren(); }
    const result = await request("/homework?offset=" + state.offset);
    el("assignmentsPanel").hidden = false;
    for (const item of result.assignments) el("assignments").append(button(
      item.class_code + " · " + item.title + " · due " + (item.due_at ? showDue(item.due_at) : item.due_on),
      () => showReport(item).catch(error => status(error.message))));
    el("older").hidden = !result.has_more;
    state.offset += result.assignments.length;
  }
  async function loadWorkspace() {
    const classes = await request("/learner-classes");
    const entries = [];
    for (let offset = 0; ; offset += 50) {
      const result = await request("/lesson-catalogue?offset=" + offset);
      entries.push(...result.entries);
      if (!result.has_more) break;
    }
    state.lessons = entries;
    el("lesson").replaceChildren(new Option("Choose a lesson", ""), ...entries.map(item => new Option(item.title, item.catalogue_id)));
    el("classCode").replaceChildren(new Option("Choose a class", ""), ...classes.classes.map(item => new Option(item.class_code + " · " + item.course + " " + item.level, item.class_code)));
    const initial = new URLSearchParams(location.search).get("catalogue");
    if (entries.some(item => item.catalogue_id === initial)) el("lesson").value = initial;
    el("assignPanel").hidden = false;
    await Promise.all([loadBlocks(), loadAssignments(true)]);
  }
  function run(action) { return action().catch(error => status(error.message)); }
  el("load").onclick = () => run(loadWorkspace);
  el("lesson").onchange = () => run(loadBlocks);
  el("classCode").onchange = () => run(loadRecipients);
  el("selectedOnly").onchange = () => { el("recipients").hidden = !el("selectedOnly").checked; };
  el("older").onclick = () => run(loadAssignments);
  el("assign").onsubmit = event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    void run(async () => {
      const block_ids = checked("blocks");
      const student_ids = el("selectedOnly").checked ? checked("recipients") : null;
      if (!block_ids.length || (student_ids && !student_ids.length)) throw new Error("Choose blocks and at least one recipient.");
      const screen = window.open("about:blank", "_blank");
      if (screen) screen.opener = null;
      const result = await request("/homework", {catalogue_id: el("lesson").value, class_code: el("classCode").value,
        due_at: duePayload("due"), block_ids, student_ids}).catch(error => {
        if (screen) screen.close();
        throw error;
      });
      if (screen) screen.location.replace(screenUrl(result.join_pin));
      await loadAssignments(true);
      await showReport({pin: result.id, title: el("lesson").selectedOptions[0].text});
      status("Assigned to " + result.assigned + " students. Show the Homework Screen or share the PIN.");
    }).finally(() => { submit.disabled = false; });
  };

  function showFeedback(container, result) {
    const panel = node("div");
    panel.className = "review";
    panel.append(node("strong", "Score " + result.score + "/" + result.max_score));
    if (result.feedback) panel.append(node("p", result.feedback));
    const list = node("ol");
    for (const item of result.items || []) {
      const row = node("li");
      row.append(node("strong", item.prompt), node("p", (item.is_correct ? "Correct · " : "Incorrect · ") + item.selected_option));
      if (!item.is_correct) {
        row.dataset.incorrect = "";
        row.append(node("p", "Expected answer: " + item.correct_option));
      }
      row.querySelectorAll("p").forEach(p => { p.className = "answer-text"; });
      list.append(row);
    }
    if (list.childElementCount) panel.append(list);
    container.append(panel);
  }

  function questionInput(form, question, index, shuffle) {
    const group = node("fieldset");
    group.append(node("legend", question.prompt));
    window.renderTaskMaterials(group, question.materials);
    form.append(group);
    if (question.parts) {
      const list = node("ol");
      list.className = "order-controls";
      question.parts.forEach((part, position) => {
        const row = node("li", part);
        row.dataset.part = position;
        const up = button("↑", () => { if (row.previousElementSibling) row.previousElementSibling.before(row); });
        const down = button("↓", () => { if (row.nextElementSibling) row.nextElementSibling.after(row); });
        up.setAttribute("aria-label", "Move up: " + part);
        down.setAttribute("aria-label", "Move down: " + part);
        row.append(" ", up, down);
        list.append(row);
      });
      group.append(list);
      return () => [...list.children].map(row => Number(row.dataset.part));
    }
    if (question.options) {
      const options = question.options.map((text, value) => ({text, value}));
      if (shuffle) for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
      }
      for (const option of options) {
        const label = node("label");
        const input = node("input");
        input.type = "radio"; input.name = "q" + index; input.value = option.value; input.required = true;
        label.append(input, " " + option.text); group.append(label);
      }
      return () => Number(group.querySelector("input:checked").value);
    }
    const input = node("input");
    input.required = true; input.maxLength = 500;
    input.setAttribute("aria-label", "Answer");
    group.append(input);
    return () => input.value;
  }

  function renderTask(item, closed) {
    const section = node("section");
    const prompt = node("p", item.task.prompt);
    prompt.className = "prompt";
    section.append(node("h2", item.title), prompt);
    window.renderTaskMaterials(section, item.task.materials);
    const submitted = result => {
      section.append(node("p", "Submitted"));
      if (result) showFeedback(section, result);
    };
    if (item.submitted) { submitted(item.result); return section; }
    if (closed) { section.append(node("p", "Submissions are closed.")); return section; }
    const form = node("form");
    const task = item.task;
    let payload;
    if (task.questions?.length) {
      const answers = task.questions.map((question, index) => questionInput(form, question, index, task.shuffle));
      payload = async () => ({response: JSON.stringify(answers.map(get => get()))});
    } else if (task.type === "speaking") {
      const label = node("label", "Upload an audio recording (WebM, MP4 or Ogg)");
      const file = node("input");
      file.type = "file"; file.accept = "audio/webm,audio/mp4,audio/ogg"; file.required = true;
      label.append(file); form.append(label);
      payload = async () => {
        const recording = file.files[0];
        if (!recording || recording.size > 5 * 1024 * 1024) throw new Error("Choose a recording under 5 MB.");
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(recording);
        });
        return {media_type: recording.type.split(";")[0], audio_base64: encoded};
      };
    } else {
      const label = node("label", "Your response");
      const answer = node("textarea");
      answer.required = true; answer.rows = 10; answer.maxLength = 20000;
      label.append(answer); form.append(label);
      payload = async () => ({response: answer.value});
    }
    const submit = node("button", "Submit answer");
    const note = node("p");
    note.setAttribute("role", "status");
    form.append(submit, note);
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const saved = await request("/homework/student/tasks/" + encodeURIComponent(item.task_id), await payload());
        form.remove();
        submitted(saved.result);
      } catch (error) { note.textContent = error.message; submit.disabled = false; }
    };
    section.append(form);
    return section;
  }

  async function loadStudent() {
    const data = await request("/homework/student");
    el("studentTitle").textContent = data.title;
    const closed = data.status !== "open";
    el("deadline").textContent = "Due " + showDue(data.due_at) + " (Vietnam time)" + (closed ? " · Closed" : "");
    el("items").replaceChildren();
    const lesson = await request("/" + data.lesson_path);
    for (const item of data.items) {
      if (item.task) { el("items").append(renderTask(item, closed)); continue; }
      const block = lesson.blocks.find(entry => entry.id === item.block_id);
      if (!block) continue;
      const section = node("section");
      const frame = node("iframe");
      frame.title = item.title;
      frame.loading = "lazy";
      frame.src = window.runtimePlayerUrl(block, "student");
      const step = Math.max(0, ...(block.elements || []).map(element => element.appear || 0));
      frame.addEventListener("load", () => frame.contentWindow?.postMessage({
        type: "reh-slide-step", block: block.id, step, interactive: true
      }, location.origin));
      section.append(node("h2", item.title), frame);
      el("items").append(section);
    }
  }
  if (studentMode) {
    const pin = params.get("pin") || "";
    el("join").hidden = false;
    if (/^[0-9]{8}$/.test(pin)) el("joinPin").value = pin;
    if (legacyLink) {
      history.replaceState(null, "", "?join=1");
      status("Enter the Homework PIN from your teacher and your Student ID.");
    }
    el("joinForm").onsubmit = event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector("button");
      submit.disabled = true;
      status("");
      void run(async () => {
        const joined = await request("/homework/join", {pin: el("joinPin").value.trim(), student_id: el("studentId").value.trim()});
        access = joined.access;
        await loadStudent();
        el("join").hidden = true;
        el("student").hidden = false;
      }).finally(() => { submit.disabled = false; });
    };
  } else {
    el("teacher").hidden = false;
    el("due").value = toInput(new Date(Date.now() + 86400000));
  }
})();
