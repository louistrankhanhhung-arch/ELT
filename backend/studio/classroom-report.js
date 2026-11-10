(() => {
  window.classroomReportTitle = (task, index) => task.page_task_title ||
    (task.prompt.length <= 95 ? task.prompt : `${task.block_id ? "Prepared task" : "Quick task"} ${index + 1}`);

  window.createClassroomReport = (popup, pin, actions) => {
    const doc = popup.document;
    doc.title = "Classroom Report";
    doc.documentElement.lang = "en";
    const style = doc.createElement("style");
    style.textContent = `
      * { box-sizing:border-box }
      body { margin:0; padding:clamp(14px,4vw,38px); background:#F7FAF3; color:#18352A; font:16px system-ui }
      main { max-width:960px; margin:auto }
      h1 { margin:0; font-size:clamp(1.65rem,5vw,2.4rem) }
      p { overflow-wrap:anywhere; white-space:pre-wrap }
      header, .task-heading, .student-heading { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px }
      button { padding:8px 12px; border:1px solid #A5BDA0; border-radius:8px; background:white; color:#18352A; cursor:pointer; font:inherit }
      button:disabled { opacity:.55; cursor:default }
      details { overflow-wrap:anywhere }
      summary { cursor:pointer }
      .task { margin:12px 0; padding:14px; background:white; border:1px solid #CCDCC8; border-radius:12px }
      .task > summary { font-weight:750 }
      .student { border-top:1px solid #CCDCC8; padding:10px 0 }
      .student-heading { display:inline-flex; width:calc(100% - 22px); font-weight:650 }
      .badge { border-radius:14px; padding:4px 9px; background:#E9F2E3; color:#286340; font-size:.82rem; font-weight:650 }
      .pending { color:#456052; background:#E9F2E3 }
      .incorrect { color:#773c09; background:#fff0dc }
      .answers { margin:10px 0; padding:0; list-style:none }
      .answers li { border:1px solid #CCDCC8; border-radius:8px; padding:10px; margin:8px 0 }
      .comparison { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,175px),1fr)); gap:8px; margin-top:8px }
      .comparison div { padding:8px; background:#F7FAF3; border-radius:7px }
      .comparison small { display:block; color:#456052; font-weight:650 }
      .comparison p { margin:4px 0 0 }
      .mastery { margin:12px 0; padding:14px; border-radius:10px; background:#F7FAF3; border:1px solid #CCDCC8 }
      .mastery h3 { margin:0 0 8px; font-size:1rem }
      .mastery p { margin:6px 0 12px; color:#456052; font-size:.9rem }
      .mastery progress { display:block; width:100%; height:9px; margin:7px 0; accent-color:#286340 }
      .mastery .missed-bar { accent-color:#ad651f }
      .missed-questions details { padding:8px 0; border-top:1px solid #CCDCC8 }
      .missed-questions summary strong { margin-right:8px }
      .missed-names { display:flex; flex-wrap:wrap; gap:6px; list-style:none; margin:8px 0 0; padding:0 }
      .missed-names li { padding:3px 8px; border-radius:8px; background:#E9F2E3; font-size:.85rem }
      audio { max-width:100%; display:block; margin:8px 0 }
      :focus-visible { outline:3px solid #4D8627; outline-offset:2px }
    `;
    doc.head.append(style);
    function node(tag, text, className) {
      const element = doc.createElement(tag);
      if (text != null) element.textContent = text;
      if (className) element.className = className;
      return element;
    }
    function control(label, handler) {
      const button = node("button", label);
      button.type = "button";
      button.addEventListener("click", handler);
      return button;
    }
    const root = node("main");
    const toolbar = node("header");
    const tools = node("div");
    const status = node("p");
    status.setAttribute("role", "status");
    const entries = node("div");
    const recordingUrls = new Set();
    let generation = 0;

    function revokeRecordings() {
      for (const url of recordingUrls) URL.revokeObjectURL(url);
      recordingUrls.clear();
    }
    popup.addEventListener("pagehide", revokeRecordings);
    toolbar.append(node("h1", "Classroom Report"), tools);
    const refreshButton = control("Refresh", () => void refresh());
    tools.append(refreshButton, control("Export CSV", async () => {
      try { await actions.export(); } catch (error) { status.textContent = error.message; }
    }));
    root.append(toolbar, node("p", "Session PIN " + pin), status, entries);
    doc.body.replaceChildren(root);

    function renderResponse(task, row, container) {
      if (task.type === "speaking") {
        const listen = control("Load recording", async () => {
          listen.disabled = true;
          try {
            const blob = await actions.audio(task, row);
            if (popup.closed || !listen.isConnected) return;
            const url = URL.createObjectURL(blob);
            recordingUrls.add(url);
            const player = node("audio");
            player.controls = true;
            player.src = url;
            listen.replaceWith(player);
          } catch (error) {
            status.textContent = error.message;
            listen.disabled = false;
          }
        });
        listen.disabled = !row.audio_type;
        if (!row.audio_type) listen.textContent = "Recording unavailable";
        container.append(listen);
      } else if (row.items?.length) {
        const list = node("ol", null, "answers");
        row.items.forEach((item, index) => {
          const question = node("li");
          const heading = node("div", null, "task-heading");
          heading.append(node("strong", `${index + 1}. ${item.prompt}`),
            node("span", item.is_correct ? "Correct" : "Incorrect", item.is_correct ? "badge" : "badge incorrect"));
          const comparison = node("div", null, "comparison");
          for (const [label, value] of [["Student answer", item.selected_option], ["Expected answer", item.correct_option]]) {
            const pair = node("div");
            pair.append(node("small", label), node("p", value));
            comparison.append(pair);
          }
          question.append(heading, comparison);
          list.append(question);
        });
        container.append(list);
      } else {
        container.append(node("p", row.response));
      }
      if (row.ai_feedback) {
        const feedback = row.ai_feedback;
        container.append(node("p", feedback.feedback));
        const scores = node("ul");
        for (const criterion of feedback.criteria) {
          scores.append(node("li", `${criterion.label} · ${criterion.score}/${criterion.max_score}${criterion.evidence ? " · “" + criterion.evidence + "”" : ""}`));
        }
        container.append(scores);
        if (feedback.difficulties.length) container.append(node("p", feedback.difficulties.map(item => item.label).join(" · ")));
        if (!row.ai_published && ["needs_review", "ready"].includes(row.ai_state)) {
          const needsReview = row.ai_state === "needs_review";
          const editor = node("details");
          editor.open = needsReview;
          editor.append(node("summary", needsReview ? "Review suggested feedback" : "Edit score and feedback"));
          const review = node("fieldset");
          review.append(node("legend", "Rubric scores and feedback"));
          const scores = {};
          for (const criterion of feedback.criteria) {
            const label = node("label", criterion.label + " ");
            const input = node("input");
            input.type = "number"; input.min = 0; input.max = criterion.max_score; input.value = criterion.score;
            input.required = true;
            scores[criterion.id] = input;
            label.append(input);
            review.append(label);
          }
          const edit = node("textarea");
          edit.value = feedback.feedback; edit.maxLength = 300; edit.rows = 3;
          edit.setAttribute("aria-label", "Feedback");
          edit.style.cssText = "display:block;width:100%;margin:8px 0;font:inherit";
          review.append(edit);
          const approve = control(needsReview ? "Approve score" : "Save changes", async () => {
            if (!edit.value.trim() || Object.values(scores).some(input => !input.value || !input.checkValidity())) {
              status.textContent = "Enter valid scores and feedback before approving.";
              return;
            }
            approve.disabled = true;
            try {
              const values = Object.fromEntries(Object.entries(scores).map(([id, input]) => [id, Number(input.value)]));
              await actions.approveWriting(task, row, values, edit.value);
              await refresh();
            }
            catch (error) { status.textContent = error.message; approve.disabled = false; }
          });
          review.append(approve);
          editor.append(review);
          container.append(editor);
        }
      }
      const show = control("Show on screen", () => actions.show(task, row));
      show.disabled = task.type === "speaking" && !row.audio_type;
      container.append(show);
    }

    function renderMastery(task, roster) {
      const panel = node("section", null, "mastery");
      const graded = task.submissions.filter(row => Number.isFinite(row.score) && row.max_score > 0);
      const mastered = graded.filter(row => row.score * 5 >= row.max_score * 4).length;
      panel.append(node("h3", "Class mastery"));
      if (!graded.length) {
        panel.append(node("p", "Mastery will appear when a graded response is submitted."));
        return panel;
      }

      const percent = Math.round(mastered * 100 / graded.length);
      const meter = node("progress");
      meter.max = graded.length;
      meter.value = mastered;
      meter.setAttribute("aria-label", "Students who reached mastery");
      const average = Math.round(100 * graded.reduce((sum, row) => sum + row.score / row.max_score, 0) / graded.length);
      panel.append(node("strong", `${percent}% reached mastery`), meter,
        node("p", `${mastered}/${graded.length} graded students scored at least 80% · Average score ${average}% · ${task.submissions.length}/${roster.length} submitted`));

      if (task.writing_rubric) {
        const difficulties = new Map();
        for (const row of graded) for (const item of row.ai_feedback?.difficulties || []) {
          if (!difficulties.has(item.id)) difficulties.set(item.id, {label: item.label, names: []});
          difficulties.get(item.id).names.push(row.student_name);
        }
        panel.append(node("h3", "Most common difficulties"));
        const list = node("div", null, "missed-questions");
        for (const [id, item] of [...difficulties].sort((a, b) => b[1].names.length - a[1].names.length).slice(0, 3)) {
          const detail = node("details");
          detail.dataset.key = task.task_id + ":difficulty:" + id;
          detail.append(node("summary", item.label + " · " + item.names.length + "/" + graded.length));
          const bar = node("progress");
          bar.max = graded.length; bar.value = item.names.length;
          bar.className = "missed-bar"; bar.setAttribute("aria-label", item.label);
          const names = node("ul", null, "missed-names");
          for (const name of item.names) names.append(node("li", name));
          detail.append(bar, names); list.append(detail);
        }
        panel.append(list.childElementCount ? list : node("p", "No rubric difficulties detected."));
        return panel;
      }
      const mistakes = task.questions.map((question, index) => {
        const checked = graded.filter(row => typeof row.items?.[index]?.is_correct === "boolean");
        const names = checked.filter(row => row.items[index].is_correct === false).map(row => row.student_name);
        return {index, prompt: question.prompt, names, checked: checked.length};
      }).filter(item => item.names.length).sort((a, b) => b.names.length - a.names.length || a.index - b.index);
      panel.append(node("h3", "Most missed questions"));
      if (!mistakes.length) {
        panel.append(node("p", graded.some(row => row.items?.length) ? "No missed questions." : "Question details are unavailable."));
        return panel;
      }
      const list = node("div", null, "missed-questions");
      for (const item of mistakes.slice(0, 3)) {
        const detail = node("details");
        detail.dataset.key = `${task.task_id}:missed:${item.index}`;
        const summary = node("summary");
        summary.append(node("strong", `Q${item.index + 1}. ${item.prompt}`),
          node("span", `${item.names.length}/${item.checked} incorrect`, "badge incorrect"));
        const bar = node("progress");
        bar.max = item.checked;
        bar.value = item.names.length;
        bar.setAttribute("aria-label", `Incorrect answers for question ${item.index + 1}`);
        bar.className = "missed-bar";
        const names = node("ul", null, "missed-names");
        for (const name of item.names) names.append(node("li", name));
        detail.append(summary, bar, names);
        list.append(detail);
      }
      panel.append(list);
      return panel;
    }

    let grading = false;
    async function gradeSubmissions(task) {
      if (grading) return;
      const candidates = task.submissions.filter(row => !["ready", "needs_review"].includes(row.ai_state));
      if (!candidates.length) return;
      grading = true;
      const controls = [...entries.querySelectorAll("[data-grade-button]")];
      controls.forEach(button => { button.disabled = true; });
      let attempted = 0;
      let firstError;
      try {
        status.textContent = "Grading 0/" + candidates.length + "…";
        for (let start = 0; start < candidates.length && !popup.closed; start += 3) {
          const results = await Promise.allSettled(candidates.slice(start, start + 3).map(row => actions.gradeWriting(task, row)));
          attempted += results.length;
          firstError ||= results.find(result => result.status === "rejected")?.reason;
          status.textContent = `Grading ${attempted}/${candidates.length}…`;
          if (firstError?.message.includes("not configured")) break;
        }
      } finally {
        grading = false;
        if (!popup.closed) {
          await refresh();
          if (firstError) status.textContent = firstError.message;
        }
      }
    }

    function render(result) {
      const wasOpen = new Set([...entries.querySelectorAll("details[open]")].map(item => item.dataset.key));
      const initial = !entries.querySelector(".task");
      revokeRecordings();
      entries.replaceChildren(...result.tasks.map((task, index) => {
        const group = node("details", null, "task");
        group.dataset.key = task.task_id;
        group.open = wasOpen.has(task.task_id) || (initial && index === result.tasks.length - 1);
        const submitted = new Map(task.submissions.map(row => [row.student_id, row]));
        const roster = task.recipient_ids ? result.students.filter(student => task.recipient_ids.includes(student.student_id)) : result.students;
        group.append(node("summary", `${window.classroomReportTitle(task, index)} · ${submitted.size}/${roster.length} submitted`),
          node("p", task.prompt));
        if (task.questions?.length || task.writing_rubric) {
          const mastery = renderMastery(task, roster);
          for (const detail of mastery.querySelectorAll("details")) detail.open = wasOpen.has(detail.dataset.key);
          group.append(mastery);
          const ai = !!task.writing_rubric;
          const ready = task.submissions.filter(row => row.ai_state === "ready").length;
          const published = ai ? !!submitted.size && task.submissions.every(row => row.ai_published) : task.scores_published;
          if (ai) {
            const grade = control("Grade Writing", () => void gradeSubmissions(task));
            grade.dataset.gradeButton = "";
            grade.disabled = grading || !task.submissions.some(row => !["ready", "needs_review"].includes(row.ai_state));
            const review = task.submissions.filter(row => row.ai_state === "needs_review").length;
            group.append(node("p", `${ready}/${submitted.size} graded · ${review} need review`), grade);
          }
          const publish = control(published ? "Scores published" : "Publish scores", async () => {
            publish.disabled = true;
            try {
              await actions.publish(task);
              await refresh();
            } catch (error) {
              status.textContent = error.message;
              publish.disabled = false;
            }
          });
          publish.disabled = published || !submitted.size || (ai && ready !== submitted.size);
          group.append(publish);
        }
        for (const student of roster) {
          const row = submitted.get(student.student_id);
          const badge = !row ? node("span", "Awaiting submission", "badge pending")
            : node("span", row.score != null ? `${row.score} / ${row.max_score}` : task.writing_rubric
              ? ({grading: "Grading", needs_review: "Needs review", failed: "Retry grading"})[row.ai_state] || "Awaiting grading"
              : "Completed", "badge");
          const heading = node("span", null, "student-heading");
          heading.append(node("span", student.student_name), badge);
          if (!row) {
            const pending = node("div", null, "student");
            pending.append(heading);
            group.append(pending);
            continue;
          }
          const panel = node("details", null, "student");
          panel.dataset.key = task.task_id + ":" + student.student_id;
          panel.open = wasOpen.has(panel.dataset.key);
          const summary = node("summary");
          summary.append(heading);
          panel.append(summary);
          renderResponse(task, row, panel);
          group.append(panel);
        }
        return group;
      }));
      if (!result.tasks.length) entries.append(node("p", "No tasks assigned yet."));
    }

    async function refresh() {
      const request = ++generation;
      refreshButton.disabled = true;
      status.textContent = "Loading report…";
      try {
        const result = await actions.load();
        if (request !== generation || popup.closed) return;
        render(result);
        status.textContent = "";
      } catch (error) {
        if (request === generation) status.textContent = error.message;
      } finally {
        if (request === generation) refreshButton.disabled = false;
      }
    }
    return { refresh };
  };
})();
