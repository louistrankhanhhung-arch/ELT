(() => {
  const el = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const studentMode = params.get("join") === "1";
  const screenPin = params.get("screen");
  const validPin = pin => /^[0-9]{8}$/.test(pin || "");
  const shortLink = pin => new URL("/t/" + pin, location.origin);
  const api = window.ELT_CONFIG.API_BASE;
  let access = "";
  function node(tag, value) {
    const element = document.createElement(tag);
    if (value != null) element.textContent = value;
    return element;
  }
  function button(label, action) {
    const element = node("button", label);
    element.type = "button";
    element.onclick = action;
    return element;
  }
  function status(value) { el("status").textContent = value; }
  function run(action) { return action().catch(error => status(error.message)); }
  async function request(path, method = "GET", payload, signal) {
    const code = studentMode ? access : el("teacherCode").value.trim();
    const response = await fetch(api + path, {
      method, cache: "no-store", signal,
      headers: {...(code ? {Authorization: "Bearer " + code} : {}), ...(payload ? {"Content-Type": "application/json"} : {})},
      body: payload ? JSON.stringify(payload) : undefined
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(new Error(typeof error.detail === "string" ? error.detail : "Check the entered values."), {status: response.status});
    }
    return response;
  }
  async function json(...args) { return (await request(...args)).json(); }

  if (screenPin !== null) {
    if (!validPin(screenPin)) { status("Invalid Test PIN."); return; }
    const link = shortLink(screenPin);
    el("screen").hidden = false;
    el("screenPin").textContent = screenPin;
    el("shortLink").href = link.href;
    el("shortLink").textContent = link.host + link.pathname;
    el("qr").src = el("downloadQR").href = link.href + "/qr.svg";
    el("downloadQR").download = "reh-test-" + screenPin + ".svg";
    return;
  }

  if (!studentMode) {
    el("teacher").hidden = false;
    let taskChoices = [];
    let selected = null;
    let report = null;
    let reportPending = false;
    const detail = window.createEvidenceDetail(el("detail"), async (path, method, payload) => {
      const response = await request(path, method, payload);
      if (!report || path !== "/session-history/" + encodeURIComponent(selected) || method) return response;
      const data = await response.json();
      const byId = new Map(data.tasks.map(task => [task.task_id, task]));
      data.tasks = report.sections.flatMap(section => section.tasks.map(item => ({
        ...byId.get(item.task_id), page_task_title: section.name + " · " + item.title
      }))).filter(task => task.task_id);
      return {json: async () => data};
    }, status);
    function section(name = "") {
      const card = node("fieldset");
      card.append(node("legend", "Timed section"));
      const title = node("input");
      title.name = "sectionName"; title.required = true; title.maxLength = 80; title.value = name;
      const minutes = node("input");
      minutes.type = "number"; minutes.name = "minutes"; minutes.min = 1; minutes.max = 180; minutes.value = 10; minutes.required = true;
      for (const [label, field] of [["Section name ", title], ["Minutes ", minutes]]) {
        const control = node("label", label); control.append(field); card.append(control);
      }
      const preparation = node("label", "Speaking preparation (seconds) ");
      const prep = node("input");
      prep.type = "number"; prep.name = "prepSeconds"; prep.min = 0; prep.max = 300; prep.value = 0; prep.required = true;
      preparation.append(prep);
      card.append(preparation);
      const tasks = node("div");
      tasks.className = "section-tasks";
      card.append(tasks, button("Remove section", () => card.remove()));
      el("sections").append(card);
      renderChoices(tasks);
    }
    function renderChoices(target) {
      target.replaceChildren(...taskChoices.map(task => {
        const label = node("label");
        const input = node("input");
        input.type = "checkbox"; input.value = task.id;
        label.append(input, " " + task.title + " · " + task.type.replaceAll("_", " "));
        return label;
      }));
      if (!taskChoices.length) target.append(node("p", "Choose a lesson with Test tasks."));
    }
    async function loadChoices() {
      const value = el("lesson").value;
      taskChoices = [];
      document.querySelectorAll(".section-tasks").forEach(renderChoices);
      if (!value) return;
      const result = await json("/tests/catalogue/" + encodeURIComponent(value));
      if (el("lesson").value !== value) return;
      taskChoices = result.tasks;
      document.querySelectorAll(".section-tasks").forEach(renderChoices);
    }
    async function loadRecipients() {
      const code = el("classCode").value;
      el("recipients").replaceChildren();
      if (!code) return;
      const result = await json("/homework/roster/" + encodeURIComponent(code));
      if (el("classCode").value !== code) return;
      for (const student of result.students) {
        const label = node("label");
        const input = node("input");
        input.type = "checkbox"; input.value = student.student_id;
        label.append(input, " " + student.display_name + " · " + student.student_id);
        el("recipients").append(label);
      }
    }
    async function loadTests() {
      const result = await json("/tests");
      el("testList").hidden = false;
      el("tests").replaceChildren(...result.tests.map(item => button(
        item.class_code + " · " + item.title + (item.published_at ? " · Published" : ""),
        () => { selected = item.pin; detail.clear(); void run(refreshReport); }
      )));
    }
    async function refreshReport() {
      if (!selected || reportPending) return;
      reportPending = true;
      const pin = selected;
      try {
        const next = await json("/tests/" + encodeURIComponent(pin) + "/report?include_tasks=false");
        if (selected !== pin) return;
        report = next;
        const waiting = report.section_index == null;
        const finished = report.section_index === report.sections.length;
        el("monitor").hidden = false;
        el("monitorTitle").textContent = report.title;
        el("monitorStatus").textContent = waiting ? "Waiting to start" : finished
          ? (report.published ? "Results published" : "Test ended")
          : report.sections[report.section_index].name + " · ends at " +
            new Date(report.ends_at).toLocaleTimeString("en-GB", {timeZone:"Asia/Ho_Chi_Minh"});
        el("showScreen").href = "test.html?screen=" + report.join_pin;
        el("start").hidden = !waiting;
        el("publish").hidden = !finished || report.published;
        el("details").hidden = waiting || report.section_index === 0;
        el("testRoster").replaceChildren(...report.roster.map(student => node("li",
          student.student_name + " · " + (!student.joined_at ? "Not joined" : waiting ? "Ready" : finished ? "Submitted" : "In progress") +
          (student.mic_checked_at ? " · Mic checked" : "")
        )));
      } finally { reportPending = false; }
    }
    async function loadWorkspace() {
      const [classes] = await Promise.all([json("/learner-classes"), loadTests()]);
      const lessons = [];
      for (let offset = 0; ; offset += 50) {
        const result = await json("/lesson-catalogue?offset=" + offset);
        lessons.push(...result.entries);
        if (!result.has_more) break;
      }
      el("lesson").replaceChildren(new Option("Choose a lesson", ""), ...lessons.map(item => new Option(item.title, item.catalogue_id)));
      el("classCode").replaceChildren(new Option("Choose a class", ""), ...classes.classes.map(item => new Option(item.class_code + " · " + item.course + " " + item.level, item.class_code)));
      if (!el("sections").children.length) section("Listening");
      el("setup").hidden = false;
      await Promise.all([loadChoices(), loadRecipients()]);
      status("");
    }
    el("load").onclick = () => run(loadWorkspace);
    el("lesson").onchange = () => run(loadChoices);
    el("classCode").onchange = () => run(loadRecipients);
    el("addSection").onclick = () => section();
    el("create").onsubmit = event => {
      event.preventDefault();
      const submit = event.submitter;
      submit.disabled = true;
      void run(async () => {
        const sections = [...el("sections").children].map(card => ({
          name: card.querySelector('[name="sectionName"]').value.trim(),
          minutes: Number(card.querySelector('[name="minutes"]').value),
          prep_seconds: Number(card.querySelector('[name="prepSeconds"]').value),
          task_ids: [...card.querySelectorAll("input:checked")].map(input => input.value)
        }));
        if (!sections.length || sections.some(item => !item.name || !item.task_ids.length)) throw new Error("Add at least one task to every section.");
        const student_ids = [...el("recipients").querySelectorAll("input:checked")].map(input => input.value);
        const result = await json("/tests", "POST", {catalogue_id: el("lesson").value, class_code: el("classCode").value, sections,
          student_ids: student_ids.length ? student_ids : null});
        selected = result.id;
        detail.clear();
        await Promise.all([loadTests(), refreshReport()]);
        status("Test created. Open Test Screen to share the PIN.");
      }).finally(() => { submit.disabled = false; });
    };
    for (const [id, action] of [["start", "start"], ["publish", "publish"]]) {
      el(id).onclick = () => run(async () => {
        if (!selected || !window.confirm(action === "start" ? "Start the shared test clock now?" : "Publish scores and answers to students?")) return;
        el(id).disabled = true;
        try {
          await json("/tests/" + encodeURIComponent(selected) + "/" + action, "POST");
          await refreshReport();
          status(action === "start" ? "Test started." : "Results published.");
        } finally { el(id).disabled = false; }
      });
    }
    el("details").onclick = () => run(async () => {
      const pin = selected;
      if (!pin || !report) return;
      if (await detail.open(pin, report.roster)) el("detail").scrollIntoView({block: "start"});
    });
    setInterval(() => { if (selected) void run(refreshReport); }, 5000);
    return;
  }


  let currentIndex = undefined;
  let deadline = null;
  let prepareDeadline = null;
  let activeRecorder = null;
  let speakingControl = null;
  let micChecking = false;
  let taskForms = [];
  let pollPending = false;
  let timer = null;
  let published = false;
  let polling = null;
  let savingTick = null;
  const storageKey = pin => "reh-test-access:" + pin;
  const note = text => { el("studentState").textContent = text; };
  function disposeForms() {
    stopSpeaking();
    speakingControl = null;
    for (const form of taskForms) {
      clearTimeout(form.pending);
      form.attempt.complete();
    }
    taskForms = [];
  }
  function remaining() { return deadline === null ? Infinity : Math.max(0, deadline - performance.now()); }
  function displayClock() {
    if (deadline === null) return;
    const preparing = speakingControl && prepareDeadline !== null && performance.now() < prepareDeadline;
    const seconds = Math.ceil((preparing ? Math.max(0, prepareDeadline - performance.now()) : remaining()) / 1000);
    el("clockLabel").textContent = preparing ? "Preparation remaining" : "Time remaining";
    if (speakingControl) speakingControl.start.disabled = preparing || !!speakingControl.started || remaining() <= 0;
    el("countdown").textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    if (remaining() <= 0 && !el("questions").inert) {
      stopSpeaking();
      el("questions").inert = true;
      note("Time is up. Opening the next section…");
      void poll();
    }
  }
  function scheduleSave(form) {
    clearTimeout(form.pending);
    form.pending = setTimeout(() => void save(form), 220);
  }
  async function save(form) {
    if (!form.draft || remaining() <= 0 || !taskForms.includes(form)) return;
    if (form.saving) { form.queued = true; return; }
    form.saving = true;
    try {
      await json("/tests/student/drafts/" + encodeURIComponent(form.id), "PUT", {
        ...form.draft(), attempt_signals: form.attempt.snapshot()
      });
      if (taskForms.includes(form) && remaining() > 0) note("Answers saved automatically.");
    } catch (error) {
      if (!taskForms.includes(form)) return;
      if (error.status === 409) void poll();
      else if (remaining() > 0) note("Could not save. Reconnecting…");
    } finally {
      form.saving = false;
      if (form.queued) { form.queued = false; void save(form); }
    }
  }
  function renderQuestion(question, index, prior, changed, shuffle) {
    const field = node("fieldset");
    field.append(node("legend", (index + 1) + ". " + question.prompt));
    window.renderTaskMaterials(field, question.materials);
    let read;
    if (question.options) {
      const choices = question.options.map((label, value) => ({label, value}));
      if (shuffle) for (let i = choices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [choices[i], choices[j]] = [choices[j], choices[i]];
      }
      for (const {label, value} of choices) {
        const item = node("label");
        const input = node("input");
        input.type = "radio"; input.name = "q" + index; input.value = value; input.checked = prior === value;
        input.onchange = changed;
        item.append(input, " " + label); field.append(item);
      }
      read = () => {
        const input = field.querySelector("input:checked");
        return input ? Number(input.value) : null;
      };
    } else if (question.parts) {
      const list = node("ol");
      let touched = prior != null;
      const order = prior || question.parts.map((_, i) => i);
      for (const value of order) {
        const row = node("li", question.parts[value]);
        row.className = "order-row"; row.dataset.index = value;
        row.append(button("Move up", () => {
          if (row.previousElementSibling) row.previousElementSibling.before(row);
          touched = true; changed();
        }), button("Move down", () => {
          if (row.nextElementSibling) row.nextElementSibling.after(row);
          touched = true; changed();
        }));
        list.append(row);
      }
      field.append(list, button("Use this order", () => { touched = true; changed(); }));
      read = () => touched ? [...list.children].map(row => Number(row.dataset.index)) : null;
    } else {
      const label = node("label", "Answer ");
      const input = node("input"); input.maxLength = 500; input.value = prior || "";
      input.oninput = changed;
      label.append(input); field.append(label);
      read = () => input.value.trim() || null;
    }
    return {field, read};
  }
  function recordingLabel(value, hasAudio) {
    if (value === "incomplete") return "Recording incomplete";
    return hasAudio ? "Recording submitted" : "No recording";
  }
  async function microphone() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Microphone recording is unavailable in this browser.");
    return navigator.mediaDevices.getUserMedia({audio: true});
  }
  function makeRecorder(stream) {
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser does not support a Test recording format.");
    return new MediaRecorder(stream, {mimeType, audioBitsPerSecond: 48000});
  }
  el("micCheck").onclick = () => run(async () => {
    if (micChecking) return;
    micChecking = true;
    el("micCheck").disabled = true;
    let stream;
    try {
      stream = await microphone();
      const recorder = makeRecorder(stream);
      const parts = [];
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      await new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error("Microphone check failed."));
        recorder.start();
        setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 2000);
      });
      if (!parts.length) throw new Error("No sound file was recorded. Check your microphone.");
      const preview = el("micPreview");
      if (preview.src) URL.revokeObjectURL(preview.src);
      preview.src = URL.createObjectURL(new Blob(parts, {type: recorder.mimeType}));
      preview.hidden = false;
      await json("/tests/student/mic-check", "POST");
      status("Microphone checked. Play the sample to verify sound.");
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      micChecking = false;
      el("micCheck").disabled = false;
    }
  });
  function encodeAudio(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read recording segment."));
      reader.readAsDataURL(blob);
    });
  }
  async function drainAudio(recording) {
    if (recording.sending || recording.failed) return;
    recording.sending = true;
    try {
      while (recording.queue.length) {
        const part = recording.queue[0];
        try {
          if (performance.now() > recording.uploadUntil) throw Object.assign(new Error("The upload window closed."), {status: 409});
          const data = part.blob ? await encodeAudio(part.blob) : "";
          await json("/tests/student/recordings/" + encodeURIComponent(recording.id) + "/chunks", "PUT",
            {sequence: part.sequence, data, final: part.final, attempt_signals: part.signals}, AbortSignal.timeout?.(3000));
          recording.queue.shift();
          if (part.final) recording.message.textContent = "Recording sent.";
        } catch (error) {
          if (error.status === 409 || error.status === 422 || performance.now() > recording.uploadUntil) {
            recording.failed = true;
            status("Recording upload stopped. The teacher can review the segments already saved.");
            return;
          }
          recording.message.textContent = "Reconnecting to upload recording…";
          setTimeout(() => void drainAudio(recording), 750);
          return;
        }
      }
    } finally { recording.sending = false; }
  }
  function stopSpeaking() {
    if (!activeRecorder) return;
    const recording = activeRecorder;
    activeRecorder = null;
    recording.finalSignals = recording.attempt.snapshot();
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
    recording.stream.getTracks().forEach(track => track.stop());
  }
  function renderSpeaking(group, item, attempt) {
    const message = node("p", item.recording_complete ? "Recording sent." :
      item.recording_started ? "A recording was started earlier. Saved segments will be kept." :
      "Start recording after the preparation timer ends.");
    const stop = button("Finish recording", () => { stopSpeaking(); stop.disabled = true; });
    stop.disabled = true;
    const start = button("Start recording", async () => {
      if (speakingControl?.started || remaining() <= 0 || performance.now() < prepareDeadline) return;
      control.started = true;
      start.disabled = true;
      let stream;
      try {
        stream = await microphone();
        if (speakingControl !== control || remaining() <= 0) throw new Error("The speaking window closed.");
        const recorder = makeRecorder(stream);
        await json("/tests/student/recordings/" + encodeURIComponent(item.task_id) + "/start", "POST",
          {media_type: recorder.mimeType.split(";")[0]});
        if (speakingControl !== control || remaining() <= 0) throw new Error("The speaking window closed.");
        const recording = {id: item.task_id, recorder, stream, attempt, message, queue: [], sequence: 0,
          uploadUntil: deadline + 12000, sending: false, failed: false};
        recorder.ondataavailable = event => {
          if (!event.data.size) return;
          recording.queue.push({blob: event.data, sequence: recording.sequence++, final: false,
            signals: recording.finalSignals || attempt.snapshot()});
          void drainAudio(recording);
        };
        recorder.onstop = () => {
          if (recording.interrupted) return;
          recording.queue.push({sequence: recording.sequence, final: true, signals: recording.finalSignals || attempt.snapshot()});
          message.textContent = "Sending recording…";
          void drainAudio(recording);
        };
        const interrupt = () => {
          recording.interrupted = true;
          if (activeRecorder === recording) stopSpeaking();
          stream.getTracks().forEach(track => track.stop());
          status("Recording was interrupted. The teacher can review saved segments.");
        };
        recorder.onerror = interrupt;
        stream.getAudioTracks().forEach(track => track.addEventListener("ended", interrupt, {once: true}));
        recorder.start(1000);
        activeRecorder = recording;
        stop.disabled = false;
        message.textContent = "Recording…";
      } catch (error) {
        stream?.getTracks().forEach(track => track.stop());
        if (error.status !== 409) control.started = false;
        message.textContent = error.message;
      }
    });
    const control = {start, started: item.recording_started};
    speakingControl = control;
    group.append(start, stop, message);
  }
  function renderSection(data) {
    disposeForms();
    el("questions").replaceChildren();
    el("questions").inert = false;
    if (data.finished) {
      note(data.published ? "Results published." : "Submitted. Wait for your teacher to publish results.");
      for (const section of data.results) {
        const card = node("section");
        card.append(node("h2", section.name));
        for (const task of section.tasks) {
          if (task.type === "speaking") {
            card.append(node("h3", task.title + (task.max_score ? " · " + task.score + "/" + task.max_score : "")),
              node("p", recordingLabel(task.recording_status, !!task.response)));
            if (task.feedback) card.append(node("p", task.feedback));
            continue;
          }
          if (task.type === "writing") {
            card.append(node("h3", task.title + (task.max_score ? " · " + task.score + "/" + task.max_score : "")));
            if (!task.response) { card.append(node("p", "No response submitted.")); continue; }
            card.append(node("h4", "Your response"), node("pre", task.response));
            if (task.rubric_scores.length) {
              const rubric = node("ul");
              task.rubric_scores.forEach(item => rubric.append(node("li", item.label + " · " + item.score + "/" + item.max_score)));
              card.append(rubric);
            }
            if (task.feedback) card.append(node("h4", "Teacher feedback"), node("p", task.feedback));
            continue;
          }
          const list = node("ol");
          card.append(node("h3", task.title + " · " + task.score + "/" + task.max_score), list);
          for (const item of task.items) {
            const row = node("li");
            row.append(node("strong", item.prompt), node("p", (item.unanswered ? "Unanswered" : item.is_correct ? "Correct" : "Incorrect") +
              (item.selected_option ? " · " + item.selected_option : "")));
            if (!item.is_correct) row.append(node("p", "Expected answer: " + item.correct_option));
            list.append(row);
          }
        }
        el("questions").append(card);
      }
      return;
    }
    if (data.section_index === null) { note("Ready. Waiting for your teacher to start the test."); return; }
    note("Answers save automatically. Device, page switches and approximate question time are recorded.");
    el("sectionName").textContent = data.section_name + " · " + (data.section_index + 1) + "/" + data.section_count;
    for (const item of data.tasks) {
      const card = node("section");
      card.append(node("h2", item.title), node("p", item.task.prompt));
      window.renderTaskMaterials(card, item.task.materials);
      const questions = item.task.questions || [];
      const attempt = window.createTaskAttemptTracker(questions.length, item.task_id + ":" + access.slice(-16));
      const form = {id: item.task_id, attempt, pending: null, saving: false, queued: false};
      const group = node("form");
      group.onsubmit = event => { event.preventDefault(); void save(form); };
      const fields = [];
      if (item.task.type === "speaking") {
        renderSpeaking(group, item, attempt);
      } else if (item.task.type === "writing") {
        const label = node("label", "Your response");
        const answer = node("textarea");
        answer.rows = 10;
        answer.maxLength = 20000;
        answer.value = item.writing || "";
        answer.oninput = () => scheduleSave(form);
        answer.onblur = () => void save(form);
        label.append(answer);
        group.append(label);
        form.draft = () => ({writing: answer.value});
      } else {
        const readers = [];
        questions.forEach((question, index) => {
          const {field, read} = renderQuestion(question, index, item.answers?.[index], () => scheduleSave(form), item.task.shuffle);
          group.append(field); fields.push(field); readers.push(read);
        });
        form.draft = () => ({answers: readers.map(read => read())});
      }
      card.append(group);
      el("questions").append(card);
      taskForms.push(form);
      attempt.mount(card, fields);
    }
    window.scrollTo(0, 0);
  }
  function applyState(data) {
    const active = data.ends_at != null;
    const observed = performance.now();
    deadline = active ? observed + Math.max(0, Date.parse(data.ends_at) - Date.parse(data.server_now)) : null;
    prepareDeadline = active && data.prepare_ends_at ? observed + (Date.parse(data.prepare_ends_at) - Date.parse(data.server_now)) : null;
    el("micCheck").hidden = !data.has_speaking || data.section_index !== null;
    if (data.section_index !== null) {
      el("micPreview").pause();
      el("micPreview").hidden = true;
    }
    el("studentTitle").textContent = data.title;
    el("clockBar").hidden = !active;
    if (data.section_index !== currentIndex || data.published !== published) {
      currentIndex = data.section_index;
      published = data.published;
      renderSection(data);
    }
    displayClock();
  }
  async function poll() {
    if (!access || pollPending) return;
    pollPending = true;
    try { applyState(await json("/tests/student")); }
    catch (error) { note(error.message); }
    finally { pollPending = false; }
  }
  async function openStudent() {
    const data = await json("/tests/student");
    el("student").hidden = false;
    applyState(data);
    if (!polling) {
      polling = setInterval(() => void poll(), 2000);
      timer = setInterval(displayClock, 200);
      savingTick = setInterval(() => taskForms.forEach(form => void save(form)), 3000);
    }
    status("");
  }
  const pin = params.get("pin");
  const key = storageKey(pin);
  const joinUrl = "join.html" + (validPin(pin) ? "?pin=" + encodeURIComponent(pin) : "");
  try { if (validPin(pin)) access = sessionStorage.getItem(key) || ""; } catch {}
  if (!access) location.replace(joinUrl);
  else void openStudent().catch(error => {
    if (error.status === 401 || error.status === 403) {
      try { sessionStorage.removeItem(key); } catch {}
      location.replace(joinUrl);
    } else status(error.message);
  });
})();
