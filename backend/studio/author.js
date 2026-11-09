
const byId = id => document.getElementById(id);
const api = window.ELT_CONFIG.API_BASE;
const phases = ["diagnosis", "teach", "practice", "retrieve", "production", "verify"];
let lesson = null;
let selected = 0;
const authorParams = new URLSearchParams(location.search);
let revision = authorParams.get("revision");
const catalogueId = authorParams.get("catalogue");

function status(message) { byId("status").textContent = message; }

async function request(path, body) {
  const response = await fetch(api + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + byId("token").value.trim(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(result.detail)
      ? result.detail.map(issue => issue.loc.join(".") + ": " + issue.msg).join(" | ")
      : result.detail;
    throw new Error(detail || "Could not save the lesson.");
  }
  return result;
}

function loadDraft(value, parent = null) {
  if (!value || value.schema_version !== 1 || typeof value.title !== "string"
      || !Array.isArray(value.blocks) || !value.blocks.length
      || value.blocks.some(block => !block || !phases.includes(block.phase)
        || !["slide", "writing", "multiple_choice", "speaking"].includes(block.kind)
        || (block.quiz?.questions != null && (!Array.isArray(block.quiz.questions) || block.quiz.questions.some(question => !question || !Array.isArray(question.options)))))) {
    throw new Error("Use a version 1 lesson with a title and valid slide or task blocks.");
  }
  lesson = value;
  revision = parent;
  selected = 0;
  byId("title").value = lesson.title;
  byId("objective").value = lesson.objective || "";
  byId("editor").hidden = false;
  byId("classroom").hidden = true;
  byId("editLink").hidden = true;
  byId("catalogueLink").hidden = true;
  render();
}

function field(parent, title, value, changed, choices, multiline = false, catalog = false) {
  const label = document.createElement("label");
  label.textContent = title;
  const input = document.createElement(choices ? "select" : multiline ? "textarea" : "input");
  if (choices) for (const choice of choices) input.add(new Option(choice || "None", choice));
  if (multiline) input.rows = 3;
  if (catalog) input.setAttribute("list", "learningTargets");
  input.value = value ?? "";
  input.addEventListener("input", () => {
    changed(input.value);
    byId("classroom").hidden = true;
    byId("editLink").hidden = true;
  byId("catalogueLink").hidden = true;
    renderPreview();
  });
  label.append(input);
  parent.append(label);
}

function renderPreview() {
  const block = lesson.blocks[selected];
  byId("preview").textContent = [
    block.title,
    block.kind === "slide" ? block.body : block.prompt,
    block.media_url || "",
    ...(block.quiz?.questions || []).map((question, index) =>
      (index + 1) + ". " + question.prompt + "\n" + question.options.join(" · "))
  ].filter(Boolean).join("\n\n");
  const active = byId("blocks").children[selected];
  if (active) active.textContent = (selected + 1) + ". " + block.phase + " · " + block.title;
}

function button(parent, label, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.addEventListener("click", action);
  parent.append(control);
}

function render() {
  const list = byId("blocks");
  list.replaceChildren();
  lesson.blocks.forEach((block, index) => {
    button(list, (index + 1) + ". " + block.phase + " · " + block.title, () => { selected = index; render(); });
    list.lastChild.className = "block";
    list.lastChild.setAttribute("aria-current", String(index === selected));
  });
  const block = lesson.blocks[selected];
  const fields = byId("fields");
  fields.replaceChildren();
  field(fields, "Block title", block.title, value => { block.title = value; });
  field(fields, "Phase", block.phase, value => { block.phase = value; }, phases);
  field(fields, "Learning target ID (optional)", block.learning_target_id, value => { block.learning_target_id = value.trim() || null; }, null, false, true);
  field(fields, "Block type", block.kind, value => { block.kind = value; render(); }, ["slide", "writing", "multiple_choice", "speaking"]);
  field(fields, "Teacher notes", block.notes, value => { block.notes = value; }, null, true);
  if (block.kind === "slide") {
    field(fields, "Slide text", block.body, value => { block.body = value; }, null, true);
    field(fields, "Media type", block.media_type, value => { block.media_type = value || null; }, ["", "image", "audio", "video"]);
    field(fields, "Media URL (direct HTTPS or YouTube for video)", block.media_url, value => { block.media_url = value.trim() || null; });
  } else {
    field(fields, "Task prompt", block.prompt, value => { block.prompt = value; }, null, true);
  }
  if (block.kind === "multiple_choice") renderQuiz(fields, block);
  byId("up").disabled = selected === 0;
  byId("down").disabled = selected === lesson.blocks.length - 1;
  byId("remove").disabled = lesson.blocks.length === 1;
  renderPreview();
}

function renderQuiz(fields, block) {
  const quiz = block.quiz ||= { questions: [], shuffle: false };
  if (!quiz.questions) {
    quiz.questions = [{ prompt: block.prompt, options: quiz.options || [], correct_option: quiz.correct_option || 0 }];
    delete quiz.options;
    delete quiz.correct_option;
  }
  const toggle = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = quiz.shuffle;
  checkbox.addEventListener("change", () => { quiz.shuffle = checkbox.checked; dirty(); });
  toggle.append(checkbox, " Shuffle options for each student");
  fields.append(toggle);
  quiz.questions.forEach((question, index) => {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Question " + (index + 1);
    group.append(legend);
    field(group, "Question", question.prompt, value => { question.prompt = value; });
    field(group, "Question ID (optional)", question.question_id, value => { question.question_id = value.trim() || null; });
    field(group, "Learning target override (optional)", question.learning_target_id,
      value => { question.learning_target_id = value.trim() || null; }, null, false, true);
    field(group, "Options (2–8, one per line)", question.options.join("\n"),
      value => { question.options = value.split(/\r?\n/); }, null, true);
    field(group, "Correct option number", String(question.correct_option + 1),
      value => { question.correct_option = Number(value) - 1; }, ["1","2","3","4","5","6","7","8"]);
    button(group, "Remove question", () => { quiz.questions.splice(index, 1); dirty(); render(); });
    fields.append(group);
  });
  button(fields, "Add question", () => {
    if (quiz.questions.length >= 30) return;
    quiz.questions.push({ prompt: "", options: ["", ""], correct_option: 0 });
    dirty();
    render();
  });
}

function dirty() {
  byId("classroom").hidden = true;
  byId("editLink").hidden = true;
  byId("catalogueLink").hidden = true;
}
function move(offset) {
  const next = selected + offset;
  if (next < 0 || next >= lesson.blocks.length) return;
  [lesson.blocks[selected], lesson.blocks[next]] = [lesson.blocks[next], lesson.blocks[selected]];
  selected = next;
  dirty();
  render();
}
function add(kind) {
  lesson.blocks.push({ id: crypto.randomUUID(), phase: "teach", kind, title: kind === "slide" ? "New slide" : "New task" });
  selected = lesson.blocks.length - 1;
  dirty();
  render();
}

byId("up").onclick = () => move(-1);
byId("down").onclick = () => move(1);
byId("remove").onclick = () => {
  if (lesson.blocks.length < 2) return;
  lesson.blocks.splice(selected, 1);
  selected = Math.min(selected, lesson.blocks.length - 1);
  dirty();
  render();
};
byId("addSlide").onclick = () => add("slide");
byId("addTask").onclick = () => add("writing");
byId("title").oninput = dirty;
byId("objective").oninput = dirty;
byId("import").onclick = () => {
  try { loadDraft(JSON.parse(byId("source").value)); status("Draft imported. Review and save a version."); }
  catch (error) { status(error.message); }
};
byId("sample").onclick = async () => {
  try {
    const response = await fetch("work-lesson-sample.json");
    loadDraft(await response.json());
    status("Work sample loaded. Review and save a version.");
  } catch (error) { status(error.message); }
};
byId("loadRevision").hidden = !revision;
byId("loadRevision").onclick = async () => {
  try {
    const result = await request("/work-lessons/" + encodeURIComponent(revision));
    loadDraft(result.lesson, revision);
    status("Version " + result.version + " loaded.");
  } catch (error) { status(error.message); }
};
byId("save").onclick = async () => {
  byId("save").disabled = true;
  try {
    lesson.title = byId("title").value.trim();
    lesson.objective = byId("objective").value.trim();
    const blocks = lesson.blocks.map(block => {
      const copy = { ...block };
      if (copy.kind !== "multiple_choice") delete copy.quiz;
      return copy;
    });
    const saved = await request("/work-lessons", { lesson: { ...lesson, blocks }, parent_revision: revision });
    revision = saved.revision;
    const catalogue = catalogueId ? "&catalogue=" + encodeURIComponent(catalogueId) : "";
    byId("classroom").href = "teacher.html?lesson=" + encodeURIComponent(saved.lesson_path) + catalogue;
    byId("editLink").href = "author.html?revision=" + encodeURIComponent(revision) + catalogue;
    byId("catalogueLink").href = "lesson-catalogue.html?revision=" + encodeURIComponent(revision) + catalogue;
    byId("catalogueLink").textContent = catalogueId ? "Publish new version" : "Save to Catalogue";
    byId("catalogueLink").hidden = false;
    byId("classroom").hidden = false;
    byId("editLink").hidden = false;
    status("Version " + saved.version + " saved. Open Classroom to teach.");
  } catch (error) { status(error.message); }
  finally { byId("save").disabled = false; }
};
