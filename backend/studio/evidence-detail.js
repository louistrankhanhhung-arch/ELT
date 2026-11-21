window.createEvidenceDetail = (root, request, status) => {
  const el = id => root.querySelector("#" + id);
  const apiPath = (pin, suffix = "") => "/session-history/" + encodeURIComponent(pin) + suffix;
  let current = null;
  let archivedPin = null;
  const objectUrls = new Set();

  function button(label, action) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.addEventListener("click", action);
    return control;
  }
  function text(tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  }
  function readableDate(value) { return new Date(value).toLocaleString("en-GB", {timeZone:"Asia/Ho_Chi_Minh"}); }
  let generation = 0;
  let roster = null;
  let scope = null;
  async function open(pin, recipients = null, reportScope = null) {
    const version = ++generation;
    const next = await (await request(apiPath(pin))).json();
    if (version !== generation) return false;
    scope = reportScope;
    current = scope?.target ? {...next, tasks: next.tasks.filter(task =>
      (task.learning_target_id || "").toLowerCase() === scope.target.toLowerCase())} : next;
    roster = recipients ?? next.students ?? [...new Map(next.tasks.flatMap(task => task.submissions).map(row => [row.student_id, row])).values()];
    if (scope) {
      const members = new Set(scope.members);
      roster = roster.filter(row => members.has(row.student_id));
    }
    if (scope?.student) current = {...current, tasks: current.tasks.filter(task => audienceFor(task).length)};
    root.hidden = false;
    el("sessionTitle").textContent = next.lesson_title;
    el("sessionSummary").textContent = [
      "PIN " + pin, readableDate(next.session.created_at), next.session.status,
      next.lesson_version ? "Lesson version " + next.lesson_version : "", !scope && next.joined + " joined"
    ].filter(Boolean).join(" · ");
    const students = new Map(roster.map(row => [row.student_id, row.student_name]));
    el("studentFilter").closest("label").hidden = !!scope?.student;
    el("archive").hidden = !!scope;
    el("studentFilter").replaceChildren(new Option("All students", ""), ...[...students].map(([id,name]) => new Option(name,id)));
    el("deletePanel").hidden = !!scope || next.session.status === "active" || !next.audio_count;
    el("deleteSummary").textContent = next.audio_count + " recordings · " + (next.audio_bytes / 1048576).toFixed(2) + " MiB. Text responses and reviews are kept.";
    el("verified").checked = false;
    el("confirmation").value = "";
    refreshDelete();
    renderSummary();
    renderTasks();
    return true;
  }
  function renderTasks() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    const filter = el("studentFilter").value;
    el("tasks").replaceChildren(...current.tasks.map((task, index) => renderTask(task, index, filter)));
    if (!current.tasks.length) el("tasks").append(text("p", "No task evidence in this view."));
  }
  function badge(value, state) {
    const label = text("span", value);
    label.className = "report-badge " + state;
    return label;
  }
  function metrics(entries) {
    const grid = document.createElement("dl");
    grid.className = "report-metrics";
    for (const [label, value, note] of entries) {
      const tile = document.createElement("div");
      tile.append(text("dt", label), text("dd", value));
      if (note) tile.append(text("small", note));
      grid.append(tile);
    }
    return grid;
  }
  function audienceFor(task) {
    if (!Array.isArray(task.recipient_ids)) return roster;
    const allowed = new Set(task.recipient_ids);
    return roster.filter(student => allowed.has(student.student_id));
  }
  function renderSummary() {
    const counts = new Map();
    let expected = 0;
    let submitted = 0;
    for (const task of current.tasks) {
      const responses = new Set(task.submissions.map(row => row.student_id));
      for (const student of audienceFor(task)) {
        expected++;
        const count = counts.get(student.student_id) || {expected: 0, submitted: 0};
        count.expected++;
        if (responses.has(student.student_id)) {
          submitted++;
          count.submitted++;
        }
        counts.set(student.student_id, count);
      }
    }
    const completed = [...counts.values()].filter(count => count.expected === count.submitted).length;
    const homework = current.session.status === "homework";
    if (homework) el("sessionSummary").textContent = current.lesson_version ? "Lesson version " + current.lesson_version : "";
    el("reportOverview").replaceChildren(metrics([
      ...(!scope?.student ? [[homework ? "Students assigned" : "Students joined", roster.length]] : []),
      ["Tasks", current.tasks.length],
      ["All assigned tasks submitted", counts.size ? completed + "/" + counts.size : "—"],
      ["Submissions", expected ? submitted + "/" + expected : "—"]
    ]));
  }
  function scoreFor(row, task) {
    if (Number.isFinite(row.review_score) && row.review_max_score > 0) return [row.review_score, row.review_max_score];
    if (scope && task?.writing_rubric && !row.ai_published && !row.rubric_scores?.length) return null;
    if ((!row.ai_state || row.ai_published) && Number.isFinite(row.score) && row.max_score > 0) return [row.score, row.max_score];
    return null;
  }
  function percent([score, maximum]) { return score * 100 / maximum; }
  const grading = new Set();
  const writingPath = (pin, task, action) =>
    "/sessions/" + encodeURIComponent(pin) + "/tasks/" + encodeURIComponent(task.task_id) + "/" + action;
  async function refreshWriting(pin) {
    if (current?.session.pin !== pin) return;
    const version = generation;
    const next = await (await request(apiPath(pin))).json();
    if (version !== generation) return;
    current = next;
    renderSummary();
    renderTasks();
  }
  function isArchivedClassroom() {
    return ["ended", "expired"].includes(current.session.status);
  }
  function writingActions(task, rows) {
    const pin = current.session.pin;
    const homework = current.session.status === "homework";
    const group = document.createElement("div");
    const responses = rows.filter(row => row.response?.trim());
    const candidates = responses.filter(row => !["ready", "needs_review"].includes(row.ai_state) &&
      (!isArchivedClassroom() || scoreFor(row, task) === null));
    const ready = responses.filter(row => row.ai_state === "ready").length;
    const needsReview = responses.filter(row => row.ai_state === "needs_review").length;
    const progress = text("span", "");
    progress.setAttribute("role", "status");
    const grade = button("Grade Writing with AI", async () => {
      if (grading.has(task.task_id)) return;
      grading.add(task.task_id);
      grade.disabled = true;
      let failure;
      try {
        for (let i = 0; i < candidates.length && current?.session.pin === pin; i += 3) {
          progress.textContent = "Grading " + i + "/" + candidates.length + "…";
          const results = await Promise.allSettled(candidates.slice(i, i + 3).map(row =>
            request(writingPath(pin, task, "grade-writing"), "POST", {student_id: row.student_id})));
          failure ||= results.find(result => result.status === "rejected")?.reason;
        }
      } finally {
        grading.delete(task.task_id);
        grade.disabled = false;
        try { await refreshWriting(pin); }
        catch (error) { failure ||= error; }
        status(failure?.message || "");
      }
    });
    grade.disabled = grading.has(task.task_id) || !candidates.length || Boolean(current.test_published);
    const awaiting = responses.filter(row => !row.ai_published && ["ready", "needs_review"].includes(row.ai_state)).length;
    const caption = isArchivedClassroom()
      ? candidates.length + " awaiting AI grading · " + awaiting + " awaiting teacher approval"
      : ready + "/" + responses.length + " AI graded · " + needsReview + " need AI review";
    group.append(text("p", caption), grade, progress);
    if (homework) {
      const published = responses.length > 0 && responses.every(row => row.ai_published);
      const publish = button(published ? "Scores published" : "Publish scores", async () => {
        publish.disabled = true;
        try {
          await request(writingPath(pin, task, "publish-scores"), "POST", {});
          await refreshWriting(pin);
        } catch (error) { status(error.message); publish.disabled = false; }
      });
      publish.disabled = published || !responses.length || ready !== responses.length;
      group.append(publish);
    }
    return group;
  }

  function renderTask(task, index, filter) {
    const article = document.createElement("article");
    const heading = document.createElement("header");
    const type = (task.type || "writing").replaceAll("_", " ");
    heading.append(text("h3", task.page_task_title || "Task " + (index + 1)), badge(task.phase ? type + " · " + task.phase : type, ""));
    article.append(heading, text("pre", task.prompt));
    const submissions = new Map(task.submissions.map(row => [row.student_id, row]));
    const audience = audienceFor(task);
    const submitted = audience.map(student => submissions.get(student.student_id)).filter(Boolean);
    const scored = submitted.map(row => scoreFor(row, task)).filter(Boolean);
    const summary = [["Submitted", submitted.length + "/" + audience.length]];
    if (scope?.student) {
      const score = scored[0];
      summary.push(["Score", score ? score.join("/") + " · " + Math.round(percent(score)) + "%" : "—"],
        ["Mastery", score ? (percent(score) >= 80 ? "Mastered" : "Below 80%") : "Not yet scored"]);
    } else if (scored.length) {
      const mastered = scored.filter(score => percent(score) >= 80).length;
      const average = Math.round(scored.reduce((sum, score) => sum + percent(score), 0) / scored.length);
      summary.push(["Average score", average + "%", scored.length + " scored"],
        ["Class mastery", Math.round(mastered * 100 / scored.length) + "%", mastered + "/" + scored.length + " scored at 80% or higher"]);
    } else if (task.questions?.length) {
      summary.push(["Average score", "—"], ["Class mastery", "—"]);
    }
    article.append(metrics(summary));
    if (!scope && task.type === "writing" && task.task_id !== "legacy-writing" &&
        (isArchivedClassroom() || ["homework", "test"].includes(current.session.status))) {
      article.append(writingActions(task, submitted));
    }
    if (!scope?.student && task.questions?.length) {
      const missed = task.questions.map((question, questionIndex) => ({
        number: questionIndex + 1, prompt: question.prompt,
        names: submitted.filter(row => row.items?.[questionIndex]?.is_correct === false).map(row => row.student_name)
      })).filter(question => question.names.length)
        .sort((a, b) => b.names.length - a.names.length || a.number - b.number).slice(0, 3);
      if (missed.length) {
        const list = document.createElement("section");
        list.className = "report-missed";
        list.append(text("h4", "Most missed questions"));
        for (const question of missed) {
          const item = document.createElement("details");
          const caption = document.createElement("summary");
          caption.append(text("span", "Q" + question.number + " · " + question.prompt),
            badge(question.names.length + " incorrect", "wrong"));
          item.append(caption, text("p", question.names.join(", ")));
          list.append(item);
        }
        article.append(list);
      }
    }
    if (!scope?.student) article.append(text("h4", "Students"));
    for (const student of audience) {
      if (filter && student.student_id !== filter) continue;
      const row = submissions.get(student.student_id);
      if (row) article.append(renderSubmission(task, row, current.session.pin));
      else {
        const pending = document.createElement("div");
        pending.className = "report-student-row";
        pending.append(text("strong", student.student_name), badge("Awaiting submission", "pending"));
        article.append(pending);
      }
    }
    return article;
  }
  function renderAnswers(task, row, panel) {
    if (!row.items?.length) {
      panel.append(text("pre", row.response));
      return;
    }
    const list = document.createElement("ol");
    list.className = "report-answers";
    row.items.forEach((item, index) => {
      const question = document.createElement("li");
      const heading = document.createElement("div");
      heading.className = "report-student-row";
      heading.append(text("strong", task.questions[index]?.prompt || "Question " + (index + 1)),
        badge(item.is_correct ? "Correct" : "Incorrect", item.is_correct ? "good" : "wrong"));
      const answers = document.createElement("dl");
      answers.className = "report-comparison";
      for (const [label, value] of [["Student answer", item.selected_option], ["Expected answer", item.correct_option]]) {
        const cell = document.createElement("div");
        cell.append(text("dt", label), text("dd", value ?? "—"));
        answers.append(cell);
      }
      question.append(heading, answers);
      list.append(question);
    });
    panel.append(list);
  }
  function renderSubmission(task, row, pin) {
    const panel = document.createElement("details");
    const testWriting = pin.startsWith("TEST-") && task.type === "writing";
    const blankWriting = testWriting && !row.response.trim();
    const testSpeaking = pin.startsWith("TEST-") && task.type === "speaking";
    const recordingState = row.recording_status === "incomplete" ? "Recording incomplete" : row.audio_bytes ? "Recording submitted" : "No recording";
    {
      const heading = document.createElement("summary");
      heading.className = "report-student-row";
      const identity = document.createElement("span");
      identity.append(text("strong", row.student_name), text("small", readableDate(row.submitted_at)));
      const score = scoreFor(row, task);
      heading.append(identity, badge(score ? score.join("/") : blankWriting ? "No response" : testSpeaking ? recordingState : "Submitted", score && percent(score) < 80 ? "pending" : "good"));
      panel.append(heading);
    }
    if (row.attempt_signals) panel.append(window.renderTaskAttemptSignals(document, row.attempt_signals));
    if (task.type === "speaking") {
      if (testSpeaking) panel.append(text("p", recordingState));
      if (row.audio_bytes) {
        const play = button("Load recording", async () => {
          play.disabled = true;
          try {
            const response = await request("/sessions/" + pin + "/tasks/" + task.task_id + "/speaking/" + row.student_id);
            if (!panel.isConnected) return;
            const audio = document.createElement("audio");
            audio.controls = true;
            audio.src = URL.createObjectURL(await response.blob());
            objectUrls.add(audio.src);
            play.replaceWith(audio);
          } catch (error) { status(error.message); play.disabled = false; }
        });
        panel.append(play);
      } else if (!testSpeaking) panel.append(text("p", "Audio archived"));
    } else if (task.questions?.length) {
      renderAnswers(task, row, panel);
    } else {
      panel.append(blankWriting ? text("p", "No Writing response was saved before time expired.") : text("pre", row.response));
    }
    if (!row.attempt_signals) panel.append(text("p", "No attempt signals recorded for this submission."));
    if (scope && row.feedback) panel.append(text("p", row.feedback));
    if (row.ai_feedback?.feedback && (!scope || row.ai_published)) {
      const grade = row.ai_feedback;
      const ai = document.createElement("section");
      ai.append(text("h4", row.ai_published ? "Published AI feedback" : "AI grading draft"),
        text("p", grade.score + "/" + grade.max_score + " · " + grade.feedback));
      panel.append(ai);
    }
    if (!scope && !task.questions?.length && task.task_id !== "legacy-writing" && !blankWriting && (!testSpeaking || row.audio_bytes) && !current.test_published) {
      const editor = document.createElement("details");
      editor.append(text("summary", "Review and feedback"), reviewForm(task, row, pin));
      panel.append(editor);
    }
    return panel;
  }
  function reviewForm(task,row,pin) {
    const form = document.createElement("form");
    form.innerHTML = '<label>Score <input name="score" type="number" min="0" max="100"></label>' +
      '<label>Maximum <input name="maximum" type="number" min="1" max="100"></label>' +
      '<label>Feedback <textarea name="feedback" maxlength="4000"></textarea></label><button>Save review</button><span role="status"></span>';
    const test = pin.startsWith("TEST-");
    const classroom = isArchivedClassroom();
    const ai = (pin.startsWith("HW-") || classroom) && !row.ai_published ? row.ai_feedback : null;
    if (classroom && ai) form.querySelector("button").textContent = "Approve and publish";
    const criteria = test ? task.writing_rubric?.criteria || [] : ai?.criteria || [];
    const rubricInputs = new Map();
    if (criteria.length) {
      form.elements.score.closest("label").hidden = true;
      form.elements.maximum.closest("label").hidden = true;
      const rubric = document.createElement("fieldset");
      rubric.append(text("legend", "Writing rubric"));
      for (const criterion of criteria) {
        const label = text("label", criterion.label + " (0–" + criterion.max_score + ")");
        const input = document.createElement("input");
        input.type = "number"; input.min = 0; input.max = criterion.max_score; input.required = true;
        input.value = row.rubric_scores?.find(item => item.id === criterion.id)?.score ??
          row.ai_feedback?.criteria?.find(item => item.id === criterion.id)?.score ?? "";
        label.append(input);
        if (criterion.description) label.append(text("small", criterion.description));
        rubric.append(label);
        rubricInputs.set(criterion.id, input);
      }
      form.prepend(rubric);
    }
    const fields = form.elements;
    fields.score.value = row.review_score ?? "";
    fields.maximum.value = row.review_max_score ?? "";
    fields.feedback.value = row.feedback ?? (test || ai ? row.ai_feedback?.feedback ?? "" : "");
    if (ai) { fields.feedback.maxLength = 300; fields.feedback.required = true; }
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const save = form.querySelector("button");
      const feedback = form.querySelector("[role=status]");
      save.disabled = true;
      try {
        const review = {score: fields.score.value === "" ? null : Number(fields.score.value),
          max_score: fields.maximum.value === "" ? null : Number(fields.maximum.value), feedback: fields.feedback.value};
        if (criteria.length) {
          review.score = review.max_score = null;
          review.criteria_scores = Object.fromEntries([...rubricInputs].map(([id, input]) => [id, Number(input.value)]));
        }
        if (ai) {
          await request(writingPath(pin, task, "approve-writing"), "POST", {
            student_id: row.student_id, scores: review.criteria_scores, feedback: review.feedback
          });
          await refreshWriting(pin);
          status(classroom ? "Writing score published." : "Writing review saved.");
          return;
        }
        await request(apiPath(pin, "/tasks/" + task.task_id + "/reviews/" + row.student_id), "PUT", review);
        if (criteria.length) {
          row.rubric_scores = criteria.map(item => ({...item, score: review.criteria_scores[item.id]}));
          review.score = row.rubric_scores.reduce((sum, item) => sum + item.score, 0);
          review.max_score = row.rubric_scores.reduce((sum, item) => sum + item.max_score, 0);
        }
        Object.assign(row, {review_score: review.score, review_max_score: review.max_score, feedback: review.feedback});
        feedback.textContent = "Review saved.";
      } catch (error) { feedback.textContent = error.message; }
      finally { save.disabled = false; }
    });
    return form;
  }
  el("studentFilter").onchange = renderTasks;
  el("archive").onclick = async () => {
    const pin = current.session.pin;
    el("archive").disabled = true;
    try {
      status("Preparing archive…");
      const response = await request(apiPath(pin, "/archive"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "session-" + pin + "-evidence.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      archivedPin = pin;
      refreshDelete();
      status("Archive ready. Open the ZIP and check the files before deleting audio.");
    } catch (error) { status(error.message); }
    finally { el("archive").disabled = false; }
  };
  function refreshDelete() {
    el("deleteAudio").disabled = !current || archivedPin !== current.session.pin ||
      !el("verified").checked || el("confirmation").value !== "DELETE AUDIO";
  }
  el("verified").onchange = refreshDelete;
  el("confirmation").oninput = refreshDelete;
  el("deleteAudio").onclick = async () => {
    if (el("deleteAudio").disabled) return;
    el("deleteAudio").disabled = true;
    const pin = current.session.pin;
    try {
      const result = await (await request(apiPath(pin, "/delete-audio"), "POST", {confirmation: "DELETE AUDIO"})).json();
      if (current?.session.pin === pin) await open(pin, current.session.status === "homework" ? roster : null);
      status("Deleted " + result.deleted + " recordings (" + (result.audio_bytes / 1048576).toFixed(2) + " MiB).");
    } catch (error) { status(error.message); refreshDelete(); }
  };

  function clear() {
    generation++;
    current = null;
    root.hidden = true;
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    el("tasks").replaceChildren();
  }
  return {open, clear, currentPin: () => current?.session.pin};
};

window.createReportEvidence = token => {
  const dialog = document.createElement("dialog");
  dialog.className = "report-evidence-dialog no-print";
  dialog.setAttribute("aria-label", "Task evidence and mastery");
  dialog.innerHTML = '<form method="dialog"><button>Close evidence</button></form>' +
    '<p role="status"></p><div hidden>' +
    '<h2 id="sessionTitle"></h2><p id="sessionSummary"></p><div id="reportOverview"></div>' +
    '<label>Student <select id="studentFilter"></select></label><button id="archive" hidden>Download archive</button>' +
    '<details id="deletePanel" hidden><p id="deleteSummary"></p><input id="verified" type="checkbox">' +
    '<input id="confirmation"><button id="deleteAudio"></button></details><div id="tasks"></div></div>';
  document.body.append(dialog);
  const message = dialog.querySelector('[role="status"]');
  const status = value => { message.textContent = value; };
  const request = async path => {
    const response = await fetch(window.ELT_CONFIG.API_BASE + path, {
      headers: {Authorization: "Bearer " + token.value.trim()}, cache: "no-store"
    });
    if (!response.ok) throw new Error("Could not load evidence (" + response.status + "). Close and try again.");
    return response;
  };
  const detail = window.createEvidenceDetail(dialog.querySelector(":scope > div"), request, status);
  dialog.addEventListener("close", detail.clear);
  return (pin, caption, scope) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = caption;
    button.setAttribute("aria-haspopup", "dialog");
    button.onclick = async () => {
      status("Loading task evidence…");
      dialog.showModal();
      try {
        if (await detail.open(pin, null, scope)) status("");
      } catch (error) {
        if (dialog.open) status(error.message);
      }
    };
    return button;
  };
};
