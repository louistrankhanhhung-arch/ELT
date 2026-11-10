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
      body { margin:0; padding:clamp(14px,4vw,38px); background:#f2f6fa; color:#17283b; font:16px system-ui }
      main { max-width:960px; margin:auto }
      h1 { margin:0; font-size:clamp(1.65rem,5vw,2.4rem) }
      p { overflow-wrap:anywhere; white-space:pre-wrap }
      header, .task-heading, .student-heading { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px }
      button { padding:8px 12px; border:1px solid #b8c7d6; border-radius:8px; background:white; color:#17283b; cursor:pointer; font:inherit }
      button:disabled { opacity:.55; cursor:default }
      details { overflow-wrap:anywhere }
      summary { cursor:pointer }
      .task { margin:12px 0; padding:14px; background:white; border:1px solid #d5e1ec; border-radius:12px }
      .task > summary { font-weight:750 }
      .student { border-top:1px solid #d5e1ec; padding:10px 0 }
      .student-heading { display:inline-flex; width:calc(100% - 22px); font-weight:650 }
      .badge { border-radius:14px; padding:4px 9px; background:#e3f4f0; color:#07554f; font-size:.82rem; font-weight:650 }
      .pending { color:#4b5e73; background:#edf1f5 }
      .incorrect { color:#773c09; background:#fff0dc }
      .answers { margin:10px 0; padding:0; list-style:none }
      .answers li { border:1px solid #d5e1ec; border-radius:8px; padding:10px; margin:8px 0 }
      .comparison { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,175px),1fr)); gap:8px; margin-top:8px }
      .comparison div { padding:8px; background:#f2f6fa; border-radius:7px }
      .comparison small { display:block; color:#4b5e73; font-weight:650 }
      .comparison p { margin:4px 0 0 }
      audio { max-width:100%; display:block; margin:8px 0 }
      :focus-visible { outline:3px solid #1876aa; outline-offset:2px }
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
      const show = control("Show on screen", () => actions.show(task, row));
      show.disabled = task.type === "speaking" && !row.audio_type;
      container.append(show);
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
        if (task.questions?.length) {
          const publish = control(task.scores_published ? "Scores published" : "Publish scores", async () => {
            publish.disabled = true;
            try {
              await actions.publish(task);
              await refresh();
            } catch (error) {
              status.textContent = error.message;
              publish.disabled = false;
            }
          });
          publish.disabled = task.scores_published || !submitted.size;
          group.append(publish);
        }
        for (const student of roster) {
          const row = submitted.get(student.student_id);
          const badge = !row ? node("span", "Awaiting submission", "badge pending")
            : node("span", row.score == null ? "Completed" : `${row.score} / ${row.max_score}`, "badge");
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
