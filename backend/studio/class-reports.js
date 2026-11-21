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
  const openEvidence = window.createReportEvidence(token);
  let reportSessions = new Map();
  let reportTarget = "";

  function evidenceButton(pin, caption) {
    return openEvidence(pin, caption, {members: reportSessions.get(pin)?.evidence_members || [], target: reportTarget});
  }

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
    return evidenceButton(session.pin, session.lesson || "Session " + session.pin);
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

  function deleteAnalysisButton(message, status, remove, onDeleted) {
    const button = node("button", "Delete");
    button.type = "button";
    button.onclick = async () => {
      if (!window.confirm(message)) return;
      button.disabled = true;
      try {
        await remove();
        await onDeleted();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    };
    return button;
  }

  function diagnosisButton(row, filters, classCode) {
    const open = node("button", "Diagnose student");
    open.type = "button";
    open.onclick = () => {
      const dialog = node("dialog");
      const heading = node("h2", "Diagnosis · " + row.student_id);
      const close = node("button", "Close");
      close.type = "button";
      close.onclick = () => dialog.close();
      const status = node("p");
      status.setAttribute("role", "status");
      const result = node("div");
      const history = node("details");
      history.append(node("summary", "Approved diagnoses"));
      const run = node("button", "Analyze");
      run.type = "button";
      const code = token.value.trim();
      const scope = {student_id: row.student_id, ...Object.fromEntries(filters)};
      const path = "/class-reports/" + encodeURIComponent(classCode) + "/diagnoses";
      async function write(url, method, data) {
        const response = await fetch(window.ELT_CONFIG.API_BASE + url, {
          method, cache: "no-store",
          headers: {Authorization: "Bearer " + code, "Content-Type": "application/json"},
          body: JSON.stringify(data)
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Diagnosis request failed.");
        return payload;
      }
      function evidenceList(evidence) {
        const list = node("details");
        list.append(node("summary", "Evidence references (" + evidence.length + ")"));
        for (const item of evidence) {
          const entry = node("div");
          entry.append(evidenceButton(item.pin,
            [item.ref, item.lesson_key, item.source, item.date, item.target].filter(Boolean).join(" · ")));
          entry.append(node("span", " " + item.prompt));
          if (item.response) entry.append(node("pre", item.response));
          list.append(entry);
        }
        return list;
      }
      function approvedExport(item) {
        const scope = item.scope || {};
        const filters = [
          ["Lesson", scope.lesson], ["Learning target", scope.target],
          ["From", scope.start], ["To", scope.end]
        ].filter(([, value]) => value).map(([label, value]) => label + ": " + value);
        const references = (item.evidence || []).map(record =>
          [record.ref, record.lesson_key, record.source, record.date, record.target].filter(Boolean).join(" · "));
        return [
          "REH · Approved diagnosis",
          "Class: " + classCode,
          "Student ID: " + row.student_id,
          "Approved: " + item.approved_at.slice(0, 10),
          ...filters,
          "", item.decision,
          ...(references.length ? ["", "Evidence references", ...references] : [])
        ].join("\n") + "\n";
      }

      const removeDiagnosis = id => write("/diagnoses/" + encodeURIComponent(id), "DELETE");
      let displayedDiagnosis = null;

      function approvedActions(item, panelStatus) {
        const actions = node("div");
        const share = node("button", "Share");
        const download = node("button", "Download");
        share.type = download.type = "button";
        const report = approvedExport(item);
        const filename = ["REH-Diagnosis", classCode, row.student_id, item.approved_at.slice(0, 10), item.id.slice(0, 8)]
          .join("-").replace(/[^A-Za-z0-9._-]/g, "_") + ".txt";
        share.onclick = async () => {
          panelStatus.textContent = "";
          try {
            if (navigator.share) {
              await navigator.share({title: "REH · Approved diagnosis", text: report});
              return;
            }
            await navigator.clipboard.writeText(report);
            panelStatus.textContent = "Approved diagnosis copied. You can paste it into a message.";
          } catch (error) {
            if (error.name !== "AbortError") panelStatus.textContent = "Sharing is unavailable. Use Download to share the file.";
          }
        };
        download.onclick = () => {
          const url = URL.createObjectURL(new Blob(["\uFEFF", report], {type: "text/plain;charset=utf-8"}));
          const anchor = node("a");
          anchor.href = url;
          anchor.download = filename;
          dialog.append(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
        actions.append(share, download, deleteAnalysisButton(
          "Delete this approved student diagnosis?", panelStatus, () => removeDiagnosis(item.id), async () => {
            if (displayedDiagnosis === item.id) result.replaceChildren();
            status.textContent = "Student diagnosis deleted.";
            await loadHistory();
          }
        ));
        return actions;
      }

      async function loadHistory(openId) {
        try {
          const data = await request(path + "/" + encodeURIComponent(row.student_id), code);
          history.replaceChildren(node("summary", "Approved diagnoses"));
          for (const item of data.diagnoses) {
            const panel = node("details");
            const panelStatus = node("p");
            panelStatus.setAttribute("role", "status");
            panel.open = item.id === openId;
            panel.append(node("summary", [item.approved_at.slice(0, 10), item.scope?.lesson, item.scope?.target].filter(Boolean).join(" · ")),
              approvedActions(item, panelStatus), panelStatus, node("pre", item.decision), evidenceList(item.evidence));
            history.append(panel);
          }
          if (!data.diagnoses.length) history.append(node("p", "No approved diagnoses yet."));
        } catch (error) {
          history.replaceChildren(node("summary", "Approved diagnoses"), node("p", error.message));
        }
      }
      run.onclick = async () => {
        run.disabled = true;
        status.textContent = "Analyzing submitted evidence…";
        result.replaceChildren();
        try {
          const draft = await write(path, "POST", scope);
          displayedDiagnosis = draft.diagnosis_id;
          const review = node("label", "Teacher decision");
          const decision = node("textarea");
          decision.rows = 12;
          decision.maxLength = 8000;
          decision.value = draft.proposal;
          review.append(decision);
          const approve = node("button", "Approve and save");
          approve.type = "button";
          approve.onclick = async () => {
            approve.disabled = discard.disabled = true;
            try {
              await write("/diagnoses/" + encodeURIComponent(draft.diagnosis_id) + "/decision",
                "PUT", {decision: decision.value});
              decision.readOnly = true;
              discard.remove();
              status.textContent = "Teacher decision saved.";
              history.open = true;
              await loadHistory(draft.diagnosis_id);
            } catch (error) {
              approve.disabled = discard.disabled = false;
              status.textContent = error.message;
            }
          };
          const discard = deleteAnalysisButton("Delete this student analysis draft?", status, async () => {
            approve.disabled = true;
            try { await removeDiagnosis(draft.diagnosis_id); }
            catch (error) { approve.disabled = false; throw error; }
          }, () => {
            result.replaceChildren();
            status.textContent = "Student analysis draft deleted.";
          });
          result.append(node("h3", "AI proposal"), evidenceList(draft.evidence), review, approve, discard);
          status.textContent = "Review the proposed diagnosis. Evidence used: " + draft.evidence.length + "/" +
            draft.submitted_count + " submitted tasks. Speaking audio is not analyzed.";
        } catch (error) {
          status.textContent = error.message;
        } finally {
          run.disabled = false;
        }
      };
      dialog.className = "diagnosis-dialog";
      dialog.append(heading, node("p", [classCode, ...Object.values(Object.fromEntries(filters))].join(" · ")), run, close, status, result, history);
      dialog.addEventListener("close", () => dialog.remove(), {once: true});
      document.body.append(dialog);
      dialog.showModal();
      loadHistory();
    };
    return open;
  }

  function clearAudio() {
    for (const audio of el("students").querySelectorAll("[data-evidence-audio]")) {
      audio.pause();
      URL.revokeObjectURL(audio.dataset.evidenceAudio);
      audio.remove();
    }
  }

  function lessonDiagnosis(lesson, filters, classCode) {
    const open = node("button", "Diagnose lesson");
    open.type = "button";
    open.onclick = async () => {
      const dialog = node("dialog");
      dialog.className = "diagnosis-dialog";
      const close = node("button", "Close");
      close.type = "button";
      close.onclick = () => dialog.close();
      const body = node("div", "Loading lesson evidence…");
      dialog.append(node("h2", "Class diagnosis · " + classCode), node("p", lesson.title), close, body);
      dialog.addEventListener("close", () => dialog.remove(), {once: true});
      document.body.append(dialog);
      dialog.showModal();
      const params = new URLSearchParams({lesson_key: lesson.key});
      for (const key of ["start", "end"]) if (filters.has(key)) params.set(key, filters.get(key));
      const analysisPanel = node("section");
      const analyze = node("button", "Analyze");
      analyze.type = "button";
      analyze.disabled = true;
      const analysisStatus = node("p", "Loading saved analysis…");
      analysisStatus.setAttribute("role", "status");
      const output = node("div");
      analysisPanel.append(node("h3", "AI lesson analysis"), analyze, analysisStatus, output);
      dialog.insertBefore(analysisPanel, body);
      const analysisPath = "/class-reports/" + encodeURIComponent(classCode) + "/lesson-analysis";
      const access = token.value.trim();
      function showAnalysis(report) {
        output.replaceChildren();
        if (!report) return;
        const roster = new Map(report.roster.map(student => [student.alias, student]));
        const reportText = report.text.replace(/\bS\d+\b/g, alias => {
          const student = roster.get(alias);
          return student ? student.name + (student.student_id ? " (" + student.student_id + ")" : "") : alias;
        });
        const errors = report.evidence.filter(item => item.correct === false && !item.unanswered);
        const explain = item => [
          item.ref + " · " + (roster.get(item.alias)?.name || item.alias),
          item.target, item.question, item.prompt,
          "Học sinh: " + (item.selected ?? "—"), "Đáp án: " + (item.expected ?? "—")
        ].filter(Boolean).join(" · ");
        const exportText = [lesson.title, "Class: " + classCode, "Saved: " + report.created_at,
          ...["start", "end"].filter(key => params.has(key)).map(key => key + ": " + params.get(key)),
          "", reportText, "", "Dẫn chứng câu sai", ...errors.map(explain)].join("\n");
        const share = node("button", "Share");
        const download = node("button", "Download");
        share.type = download.type = "button";
        share.onclick = async () => {
          try {
            if (navigator.share) await navigator.share({title: lesson.title, text: exportText});
            else {
              await navigator.clipboard.writeText(exportText);
              analysisStatus.textContent = "Analysis copied.";
            }
          } catch (error) {
            if (error.name !== "AbortError") analysisStatus.textContent = "Sharing is unavailable. Use Download.";
          }
        };
        download.onclick = () => {
          const url = URL.createObjectURL(new Blob(["\uFEFF", exportText], {type: "text/plain;charset=utf-8"}));
          const anchor = node("a");
          anchor.href = url;
          anchor.download = ("REH-Class-Diagnosis-" + classCode + "-" + lesson.key).replace(/[^A-Za-z0-9._-]/g, "_") + ".txt";
          dialog.append(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
        const evidence = node("details");
        evidence.append(node("summary", "Incorrect answers (" + errors.length + ")"));
        for (const item of errors) {
          const entry = node("p", explain(item) + " ");
          entry.append(evidenceButton(item.pin, "Open evidence"));
          evidence.append(entry);
        }
        const remove = deleteAnalysisButton("Delete the saved analysis for this class, lesson and date range?",
          analysisStatus, async () => {
            if (analyze.disabled) throw new Error("Wait for the current analysis to finish.");
            const query = new URLSearchParams(params);
            query.set("created_at", report.created_at);
            analyze.disabled = true;
            try {
              const response = await fetch(window.ELT_CONFIG.API_BASE + analysisPath + "?" + query, {
                method: "DELETE", headers: {Authorization: "Bearer " + access}, cache: "no-store"
              });
              if (!response.ok) {
                const data = await response.json();
                throw new Error(typeof data.detail === "string" ? data.detail : "Could not delete lesson analysis.");
              }
            } finally {
              analyze.disabled = false;
            }
          }, () => {
            showAnalysis(null);
            analysisStatus.textContent = "Lesson analysis deleted.";
          });
        output.append(share, download, remove, node("pre", reportText), evidence);
      }
      request(analysisPath + "?" + params, access).then(data => {
        showAnalysis(data.analysis);
        analysisStatus.textContent = data.analysis ? "Saved analysis · " + data.analysis.created_at.slice(0, 10) : "";
      }).catch(error => { analysisStatus.textContent = error.message; }).finally(() => { analyze.disabled = false; });
      analyze.onclick = async () => {
        analyze.disabled = true;
        analysisStatus.textContent = "Analyzing lesson evidence…";
        try {
          const response = await fetch(window.ELT_CONFIG.API_BASE + analysisPath, {
            method: "POST", cache: "no-store",
            headers: {Authorization: "Bearer " + access, "Content-Type": "application/json"},
            body: JSON.stringify(Object.fromEntries(params))
          });
          const data = await response.json();
          if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Analysis failed.");
          showAnalysis(data.analysis);
          analysisStatus.textContent = "Analysis saved.";
        } catch (error) {
          analysisStatus.textContent = error.message;
        } finally {
          analyze.disabled = false;
        }
      };
      const examples = records => {
        const list = node("ul");
        for (const record of records) {
          const item = node("li");
          item.append(evidenceButton(record.pin, record.target + " · " + sourceName(record.source)));
          item.append(node("div", record.prompt || ""));
          if (record.task_score) item.append(node("div", "Task score below the 80% review threshold."));
          else item.append(node("div", "Answer: " + (record.selected ?? "—") + " · Expected: " + (record.expected ?? "—")));
          list.append(item);
        }
        return list;
      };
      const guidance = {
        "Support first": "Check the repeated difficulty with one new equivalent item. If it recurs, model the exact step, then retest independently.",
        "Verify next": "Use one new independent item for the difficulty shown below before choosing an intervention.",
        "Insufficient evidence": "Collect one independent response for a lesson target before assigning support.",
        "Monitor": "Check transfer with one new item before moving on."
      };
      try {
        const data = await request("/class-reports/" + encodeURIComponent(classCode) + "/lesson-diagnosis?" + params,
          token.value.trim());
        body.replaceChildren(node("p", "Planning signals from lesson evidence. Review priority is based on observed errors and task scores."));
        if (!data.students.length) body.append(node("p", "No classroom or homework evidence matches this lesson."));
        body.append(node("h3", "Class priorities"));
        if (!data.targets.length) body.append(node("p", "No scored target evidence available."));
        for (const target of data.targets) {
          const panel = node("details");
          panel.append(node("summary", [target.target, target.label,
            target.needs_verify + "/" + target.checked + " students to verify"].filter(Boolean).join(" · ")));
          if (target.examples.length) panel.append(examples(target.examples),
            node("p", target.needs_verify >= 2
              ? "Start the next lesson with an equivalent class check. If the difficulty recurs, group students by the error shown."
              : "Verify this difficulty individually with an equivalent item."));
          body.append(panel);
        }
        body.append(node("h3", "Student priorities"));
        for (const student of data.students) {
          const panel = node("details");
          panel.append(node("summary", student.name + (/^STU[0-9]+$/.test(student.id) ? " · " + student.id : "") +
            " · " + student.priority + " · " + student.submitted + "/" + student.assigned + " submitted"),
            node("p", guidance[student.priority]));
          if (student.examples.length) panel.append(examples(student.examples));
          if (/^STU[0-9]+$/.test(student.id)) {
            const individualFilters = new URLSearchParams(params);
            individualFilters.delete("lesson_key");
            individualFilters.set("lesson", lesson.key);
            const button = diagnosisButton({student_id: student.id}, individualFilters, classCode);
            button.addEventListener("click", () => dialog.close(), {capture: true});
            panel.append(button);
          }
          body.append(panel);
        }
      } catch (error) {
        body.textContent = error.message;
      }
    };
    return open;
  }

  function render(data, filters) {
    const info = data.class;
    reportSessions = new Map(data.sessions.map(session => [session.pin, session]));
    reportTarget = filters.get("target") || "";
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

    table("lessons", ["Lesson", "Classroom submitted", "Homework submitted", "Test submitted", "Diagnosis"], data.lessons.map(row => {
      const select = node("button", row.title);
      select.type = "button";
      select.onclick = () => {
        el("filters").elements.lesson.value = row.key;
        el("filters").requestSubmit();
      };
      return [select, submittedCount(row.sources.classroom), submittedCount(row.sources.homework), submittedCount(row.sources.test), lessonDiagnosis(row, filters, info.class_code)];
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
      const actions = node("div");
      actions.append(learnerEvidence(row, filters, info.class_code));
      if (/^STU[0-9]+$/.test(row.student_id || "")) actions.append(diagnosisButton(row, filters, info.class_code));
      return [learner, row.submitted + "/" + row.assigned, row.mastered + "/" + row.scored, latest, signal, actions];
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
