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
  async function open(pin, recipients = null) {
    const version = ++generation;
    const next = await (await request(apiPath(pin))).json();
    if (version !== generation) return false;
    current = next;
    roster = recipients ?? next.students ?? [...new Map(next.tasks.flatMap(task => task.submissions).map(row => [row.student_id, row])).values()];
    root.hidden = false;
    el("sessionTitle").textContent = next.lesson_title;
    el("sessionSummary").textContent = [
      "PIN " + pin, readableDate(next.session.created_at), next.session.status,
      next.lesson_version ? "Lesson version " + next.lesson_version : "", next.joined + " joined"
    ].filter(Boolean).join(" · ");
    const students = new Map(roster.map(row => [row.student_id, row.student_name]));
    el("studentFilter").replaceChildren(new Option("All students", ""), ...[...students].map(([id,name]) => new Option(name,id)));
    el("deletePanel").hidden = next.session.status === "active" || !next.audio_count;
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
      [homework ? "Students assigned" : "Students joined", roster.length],
      ["Tasks", current.tasks.length],
      ["All assigned tasks submitted", counts.size ? completed + "/" + counts.size : "—"],
      ["Submissions", expected ? submitted + "/" + expected : "—"]
    ]));
  }
  function scoreFor(row) {
    if (Number.isFinite(row.review_score) && row.review_max_score > 0) return [row.review_score, row.review_max_score];
    if (Number.isFinite(row.score) && row.max_score > 0) return [row.score, row.max_score];
    return null;
  }
  function percent([score, maximum]) { return score * 100 / maximum; }
  function renderTask(task, index, filter) {
    const article = document.createElement("article");
    const heading = document.createElement("header");
    const type = (task.type || "writing").replaceAll("_", " ");
    heading.append(text("h3", task.page_task_title || "Task " + (index + 1)), badge(task.phase ? type + " · " + task.phase : type, ""));
    article.append(heading, text("pre", task.prompt));
    const submissions = new Map(task.submissions.map(row => [row.student_id, row]));
    const audience = audienceFor(task);
    const submitted = audience.map(student => submissions.get(student.student_id)).filter(Boolean);
    const scored = submitted.map(scoreFor).filter(Boolean);
    const summary = [["Submitted", submitted.length + "/" + audience.length]];
    if (scored.length) {
      const mastered = scored.filter(score => percent(score) >= 80).length;
      const average = Math.round(scored.reduce((sum, score) => sum + percent(score), 0) / scored.length);
      summary.push(["Average score", average + "%", scored.length + " scored"],
        ["Class mastery", Math.round(mastered * 100 / scored.length) + "%", mastered + "/" + scored.length + " scored at 80% or higher"]);
    } else if (task.questions?.length) {
      summary.push(["Average score", "—"], ["Class mastery", "—"]);
    }
    article.append(metrics(summary));
    if (task.questions?.length) {
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
    article.append(text("h4", "Students"));
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
    {
      const heading = document.createElement("summary");
      heading.className = "report-student-row";
      const identity = document.createElement("span");
      identity.append(text("strong", row.student_name), text("small", readableDate(row.submitted_at)));
      const score = scoreFor(row);
      heading.append(identity, badge(score ? score.join("/") : "Submitted", score && percent(score) < 80 ? "pending" : "good"));
      panel.append(heading);
    }
    if (row.attempt_signals) panel.append(window.renderTaskAttemptSignals(document, row.attempt_signals));
    if (task.type === "speaking") {
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
      } else panel.append(text("p", "Audio archived"));
    } else if (task.questions?.length) {
      renderAnswers(task, row, panel);
    } else {
      panel.append(text("pre", row.response));
    }
    if (!row.attempt_signals) panel.append(text("p", "No attempt signals recorded for this submission."));
    if (row.ai_feedback?.feedback) panel.append(text("p", row.ai_feedback.feedback));
    if (!task.questions?.length && task.task_id !== "legacy-writing") {
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
    const fields = form.elements;
    fields.score.value = row.review_score ?? "";
    fields.maximum.value = row.review_max_score ?? "";
    fields.feedback.value = row.feedback ?? "";
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const save = form.querySelector("button");
      const feedback = form.querySelector("[role=status]");
      save.disabled = true;
      try {
        const review = {score: fields.score.value === "" ? null : Number(fields.score.value),
          max_score: fields.maximum.value === "" ? null : Number(fields.maximum.value), feedback: fields.feedback.value};
        await request(apiPath(pin, "/tasks/" + task.task_id + "/reviews/" + row.student_id), "PUT", review);
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
