
const byId = id => document.getElementById(id);
const api = window.ELT_CONFIG.API_BASE;
const phases = ["diagnosis", "teach", "practice", "retrieve", "production", "verify"];
let lesson = null;
let selected = 0;
let selectedElement = null;
let revealPreview = -1;
const authorParams = new URLSearchParams(location.search);
let revision = authorParams.get("revision");
let catalogueId = authorParams.get("catalogue");
let hasUnsavedChanges = false;

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

function validTable(element) {
  if (element?.kind !== "table") return true;
  const rows = element.cells;
  return Array.isArray(rows) && rows.length >= 1 && rows.length <= 12
    && Array.isArray(rows[0]) && rows[0].length >= 1 && rows[0].length <= 8
    && rows.every(row => Array.isArray(row) && row.length === rows[0].length
      && row.every(cell => typeof cell === "string" && cell.length <= 300));
}

function loadDraft(value, parent = null) {
  if (!value || value.schema_version !== 1 || typeof value.title !== "string"
      || !Array.isArray(value.blocks) || !value.blocks.length
      || value.blocks.some(block => !block || !phases.includes(block.phase)
        || !["slide", "page", "dialogue", "writing", "multiple_choice", "speaking", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"].includes(block.kind)
        || (block.elements != null && (!Array.isArray(block.elements) || !block.elements.every(validTable)))
        || (block.quiz?.questions != null && (!Array.isArray(block.quiz.questions) || block.quiz.questions.some(question => !question || !Array.isArray(question.options)))))) {
    throw new Error("Use a version 1 lesson with a title and valid slide or task blocks.");
  }
  lesson = value;
  revision = parent;
  hasUnsavedChanges = !parent;
  selected = 0;
  selectedElement = null;
  revealPreview = -1;
  byId("course").value = lesson.course || "";
  byId("level").value = lesson.level ?? "";
  byId("title").value = lesson.title;
  byId("objective").value = lesson.objective || "";
  byId("editor").hidden = false;
  byId("classroom").hidden = true;
  byId("editLink").hidden = true;
  byId("catalogueLink").hidden = true;
  render();
}

function field(parent, title, value, changed, choices, multiline = false, catalog = false, inputType = "text") {
  const label = document.createElement("label");
  label.textContent = title;
  const input = document.createElement(choices ? "select" : multiline ? "textarea" : "input");
  if (!choices && !multiline) input.type = inputType;
  if (choices) for (const choice of choices) input.add(new Option(({ordering_sentence: "Ordering Sentence", ordering_paragraph: "Ordering Paragraph", dialogue: "Dialogue Card A/B"})[choice] || choice || "None", choice));
  if (multiline) input.rows = 3;
  if (catalog) input.setAttribute("list", "learningTargets");
  input.value = value ?? "";
  input.addEventListener("input", () => {
    changed(input.value);
    dirty();
    renderPreview();
  });
  label.append(input);
  parent.append(label);
}

function positionElement(item, element) {
  Object.assign(item.style, {
    left: element.x + "%", top: element.y + "%",
    width: element.width + "%", height: element.height + "%"
  });
}

function drawElement(element, thumbnail = false) {
  const item = document.createElement("div");
  item.className = "preview-element " + (element.kind === "shape" ? element.shape : element.kind);
  positionElement(item, element);
  REHSlideStyle.apply(item, element);
  if (element.kind === "shape") {
    const label = document.createElement("span");
    label.className = "shape-label";
    label.textContent = element.text || "";
    item.append(REHSlideStyle.shape(element), label);
  } else if (element.kind === "table") {
    item.append(REHSlideStyle.table(element));
  } else if (element.kind === "image" && /^https:\/\//.test(element.url || "")) {
    const image = document.createElement("img");
    image.src = element.url;
    image.alt = element.text || "";
    image.draggable = false;
    if (thumbnail) image.loading = "lazy";
    item.append(image);
  } else if (element.kind === "text") {
    REHSlideStyle.text(item, element);
  } else item.textContent = element.kind === "audio" ? REHSlideStyle.audioLabel(element) : element.text || "";
  return item;
}

function updateGeometry(element, next) {
  const round = value => Math.round(value * 10) / 10;
  element.x = Math.min(99, Math.max(0, round(next.x)));
  element.y = Math.min(99, Math.max(0, round(next.y)));
  element.width = Math.min(100 - element.x, Math.max(1, round(next.width)));
  element.height = Math.min(100 - element.y, Math.max(1, round(next.height)));
}

function bindCanvasPointer(item, element, canvas) {
  item.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    item.focus({preventScroll:true});
    selectedElement = element;
    for (const other of canvas.children) {
      other.classList.toggle("is-selected", other === item);
      other.setAttribute("aria-pressed", String(other === item));
    }
    const resize = event.target.classList.contains("resize-handle");
    const bounds = canvas.getBoundingClientRect();
    const start = {x:element.x, y:element.y, width:element.width, height:element.height};
    const startX = event.clientX;
    const startY = event.clientY;
    const pointer = event.pointerId;
    item.setPointerCapture(pointer);
    function move(drag) {
      if (drag.pointerId !== pointer) return;
      const dx = (drag.clientX - startX) / bounds.width * 100;
      const dy = (drag.clientY - startY) / bounds.height * 100;
      updateGeometry(element, resize ? {...start,width:start.width+dx,height:start.height+dy} : {
        ...start, x:Math.min(100-start.width,start.x+dx), y:Math.min(100-start.height,start.y+dy)
      });
      positionElement(item, element);
    }
    function finish(drag) {
      if (drag.pointerId !== pointer) return;
      item.removeEventListener("pointermove", move);
      item.removeEventListener("pointerup", finish);
      item.removeEventListener("pointercancel", finish);
      if (Object.keys(start).some(key => start[key] !== element[key])) dirty();
      renderInspector();
      refreshThumbnail();
    }
    item.addEventListener("pointermove", move);
    item.addEventListener("pointerup", finish);
    item.addEventListener("pointercancel", finish);
  });
  item.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectedElement = element;
      renderInspector();
      for (const other of canvas.children) {
        other.classList.toggle("is-selected", other === item);
        other.setAttribute("aria-pressed", String(other === item));
      }
      return;
    }
    const delta = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if (!delta) return;
    event.preventDefault();
    selectedElement = element;
    const [dx,dy] = delta;
    updateGeometry(element, event.shiftKey
      ? {...element,width:element.width+dx,height:element.height+dy}
      : {...element,x:Math.min(100-element.width,element.x+dx),y:Math.min(100-element.height,element.y+dy)});
    positionElement(item, element);
    for (const other of canvas.children) {
      other.classList.toggle("is-selected", other === item);
      other.setAttribute("aria-pressed", String(other === item));
    }
    dirty();
    renderInspector();
    refreshThumbnail();
  });
}

function refreshThumbnail() {
  const block = lesson.blocks[selected];
  const active = byId("blocks").children[selected];
  if (!active) return;
  active.querySelector(".block-label").textContent = (selected + 1) + ". " + block.phase + " · " + block.title;
  fillThumbnail(active.querySelector(".thumbnail"), block);
}

function fillThumbnail(thumb, block) {
  thumb.replaceChildren();
  if (["slide", "page"].includes(block.kind) && block.elements?.length) {
    for (const element of block.elements) {
      if (element.appear > 0) continue;
      thumb.append(drawElement(element, true));
    }
  } else {
    thumb.textContent = ["slide", "page"].includes(block.kind) ? block.title : block.kind.replace("_", " ");
  }
}

function renderPreview() {
  const block = lesson.blocks[selected];
  const canvas = byId("elementPreview");
  const isSlide = ["slide", "page"].includes(block.kind);
  const elements = isSlide ? block.elements || [] : [];
  canvas.hidden = !isSlide;
  byId("canvasTools").hidden = !isSlide;
  byId("preview").hidden = isSlide && Boolean(elements.length);
  byId("preview").textContent = [
    block.title, isSlide || block.kind === "dialogue" ? block.body : block.prompt, block.media_url || "",
    ...(block.quiz?.questions || []).map((q, index) => (index + 1) + ". " + q.prompt + "\n" + q.options.join(" · "))
  ].filter(Boolean).join("\n\n");
  canvas.replaceChildren();
  if (isSlide) {
    const reveal = byId("previewReveal");
    const steps = [...new Set([0, ...elements.flatMap(element => [element.appear, element.disappear])
      .filter(Number.isInteger)])].sort((a,b) => a-b);
    if (revealPreview !== -1 && !steps.includes(revealPreview)) revealPreview = -1;
    reveal.replaceChildren(new Option("Show all layers", "-1"), ...steps.map(step => new Option("Reveal " + step, step)));
    reveal.value = String(revealPreview);
    for (const [index, element] of elements.entries()) {
      if (revealPreview >= 0 && (revealPreview < (element.appear || 0)
          || (element.disappear != null && revealPreview >= element.disappear))) continue;
      const item = drawElement(element);
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", (index + 1) + ". " + element.kind + (element.text ? " · " + element.text : ""));
      item.setAttribute("aria-pressed", String(selectedElement === element));
      item.classList.toggle("is-selected", selectedElement === element);
      const handle = document.createElement("span");
      handle.className = "resize-handle";
      handle.setAttribute("aria-hidden", "true");
      item.append(handle);
      bindCanvasPointer(item, element, canvas);
      canvas.append(item);
    }
  }
  refreshThumbnail();
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
    button(list, "", () => { selected = index; selectedElement = null; revealPreview = -1; render(); });
    const item = list.lastChild;
    item.className = "block";
    item.setAttribute("aria-current", String(index === selected));
    const thumb = document.createElement("span");
    thumb.className = "thumbnail";
    thumb.setAttribute("aria-hidden", "true");
    fillThumbnail(thumb, block);
    const label = document.createElement("span");
    label.className = "block-label";
    label.textContent = (index + 1) + ". " + block.phase + " · " + block.title;
    item.append(thumb, label);
  });
  const block = lesson.blocks[selected];
  const fields = byId("fields");
  fields.replaceChildren();
  field(fields, "Block title", block.title, value => { block.title = value; });
  field(fields, "Phase", block.phase, value => { block.phase = value; }, phases);
  field(fields, "Learning target ID (optional)", block.learning_target_id, value => { block.learning_target_id = value.trim() || null; }, null, false, true);
  field(fields, "Block type", block.kind, value => { block.kind = value; render(); }, ["slide", "page", "dialogue", "writing", "multiple_choice", "speaking", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"]);
  field(fields, "Teacher notes", block.notes, value => { block.notes = value; }, null, true);
  if (["slide", "page"].includes(block.kind)) {
    field(fields, "Slide text", block.body, value => { block.body = value; }, null, true);
    field(fields, "Media type", block.media_type, value => { block.media_type = value || null; }, ["", "image", "audio", "video"]);
    field(fields, "Media URL (direct HTTPS or YouTube for video)", block.media_url, value => { block.media_url = value.trim() || null; });
    renderElements(fields, block);
    renderInspector();
  } else if (block.kind === "dialogue") {
    byId("elementInspector").replaceChildren();
    field(fields, "Shared instructions", block.body, value => { block.body = value; }, null, true);
    renderMaterialEditor(fields, block, 12, "Shared input materials");
    field(fields, "Role A card", block.role_a, value => { block.role_a = value; }, null, true);
    renderMaterialEditor(fields, block, 12, "Role A input materials", "role_a_materials");
    field(fields, "Role B card", block.role_b, value => { block.role_b = value; }, null, true);
    renderMaterialEditor(fields, block, 12, "Role B input materials", "role_b_materials");
  } else {
    byId("elementInspector").replaceChildren();
    field(fields, "Task prompt", block.prompt, value => { block.prompt = value; }, null, true);
    renderMaterialEditor(fields, block, 12);
    if (block.kind === "writing") renderWritingRubric(fields, block);
  }
  if (block.kind === "multiple_choice") renderQuiz(fields, block);
  if (isTextAssessment(block.kind)) renderTextQuestions(fields, block);
  if (isOrdering(block.kind)) renderOrderingQuestions(fields, block);
  if (block.kind === "page") renderPageTasks(fields, block);
  byId("up").disabled = selected === 0;
  byId("down").disabled = selected === lesson.blocks.length - 1;
  byId("remove").disabled = lesson.blocks.length === 1;
  renderPreview();
}

function renderPageTasks(fields, block) {
  const tasks = block.tasks ||= [];
  tasks.forEach((task, index) => {
    const group = document.createElement("details");
    group.open = true;
    const heading = document.createElement("summary");
    heading.textContent = "Task " + (index + 1);
    group.append(heading);
    field(group, "Task title", task.title, value => { task.title = value; });
    field(group, "Task type", task.kind, value => { task.kind = value; if (value !== "multiple_choice") delete task.quiz; if (!isTextAssessment(value)) delete task.text_questions; if (!isOrdering(value)) delete task.ordering_questions; render(); },
      ["writing", "multiple_choice", "speaking", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"]);
    field(group, "Audience label (blank = everyone)", task.audience_label, value => { task.audience_label = value.trim() || null; });
    field(group, "Learning target ID (optional)", task.learning_target_id,
      value => { task.learning_target_id = value.trim() || null; }, null, false, true);
    field(group, "Task prompt", task.prompt, value => { task.prompt = value; }, null, true);
    renderMaterialEditor(group, task, 12);
    if (task.kind === "writing") renderWritingRubric(group, task);
    if (task.kind === "multiple_choice") renderQuiz(group, task);
    if (isTextAssessment(task.kind)) renderTextQuestions(group, task);
    if (isOrdering(task.kind)) renderOrderingQuestions(group, task);
    button(group, "Remove task", () => { tasks.splice(index, 1); dirty(); render(); });
    fields.append(group);
  });
  if (tasks.length < 20) button(fields, "Add task to Page", () => {
    tasks.push({id: crypto.randomUUID(), title: "New task", kind: "writing", prompt: ""});
    dirty();
    render();
  });
}

function isOrdering(kind) { return kind === "ordering_sentence" || kind === "ordering_paragraph"; }

function renderOrderingQuestions(parent, task) {
  const items = task.ordering_questions ||= [];
  items.forEach((item, index) => {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Ordering item " + (index + 1);
    group.append(legend);
    field(group, "Question", item.prompt, value => { item.prompt = value; });
    const label = task.kind === "ordering_sentence" ? "Words or chunks" : "Sentences or chunks";
    field(group, label + " in the correct order (one per line)", item.parts.join("\n"),
      value => { item.parts = value.split(/\r?\n/).map(part => part.trim()).filter(Boolean); }, null, true);
    field(group, "Learning target override (optional)", item.learning_target_id,
      value => { item.learning_target_id = value.trim() || null; }, null, false, true);
    renderMaterialEditor(group, item, 8);
    button(group, "Remove item", () => { items.splice(index, 1); dirty(); render(); });
    parent.append(group);
  });
  if (items.length < 30) button(parent, "Add ordering item", () => {
    items.push({prompt: "Put the parts in the correct order.", parts: []});
    dirty();
    render();
  });
}

function isTextAssessment(kind) { return kind === "cloze" || kind === "short_answer"; }

function renderTextQuestions(parent, task) {
  const items = task.text_questions ||= [];
  const cloze = task.kind === "cloze";
  items.forEach((item, index) => {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = (cloze ? "Blank " : "Question ") + (index + 1);
    group.append(legend);
    field(group, cloze ? "Sentence with one ___" : "Question", item.prompt, value => { item.prompt = value; });
    field(group, "Accepted answers (one per line)", item.accepted_answers.join("\n"),
      value => { item.accepted_answers = value.split(/\r?\n/).map(answer => answer.trim()).filter(Boolean); }, null, true);
    field(group, "Learning target override (optional)", item.learning_target_id,
      value => { item.learning_target_id = value.trim() || null; }, null, false, true);
    renderMaterialEditor(group, item, 8);
    button(group, "Remove item", () => { items.splice(index, 1); dirty(); render(); });
    parent.append(group);
  });
  if (items.length < 30) button(parent, cloze ? "Add blank" : "Add question", () => {
    items.push({prompt: "", accepted_answers: []});
    dirty();
    render();
  });
}

function renderWritingRubric(parent, task) {
  const panel = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "AI Writing rubric";
  panel.append(summary);
  const rubric = task.writing_rubric;
  if (!rubric) {
    button(panel, "Add rubric", () => {
      task.writing_rubric = {
        criteria: [{id: "task_response", label: "Task response", max_score: 4,
          description: "4: all parts answered clearly; 3: mostly complete; 2: partly complete; 1: minimal relevant response; 0: absent or off-topic."}],
        difficulties: [{id: "missing_part", label: "Missing task part",
          description: "One or more required parts of the prompt are unanswered."}]
      };
      dirty();
      render();
    });
  } else {
    for (const [key, title] of [["criteria", "Scoring criteria"], ["difficulties", "Difficulties to track"]]) {
      const list = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = title;
      list.append(legend);
      const items = rubric[key] ||= [];
      items.forEach((item, index) => {
        const group = document.createElement("div");
        field(group, "ID", item.id, value => { item.id = value.trim(); });
        field(group, "Label", item.label, value => { item.label = value; });
        field(group, "Scoring rules or observable evidence", item.description, value => { item.description = value; }, null, true);
        if (key === "criteria") field(group, "Max points", item.max_score,
          value => { item.max_score = Number(value); }, ["1","2","3","4","5","6","7","8","9","10"]);
        button(group, "Remove " + (key === "criteria" ? "criterion" : "difficulty"), () => {
          rubric[key].splice(index, 1); dirty(); render();
        });
        list.append(group);
      });
      if (rubric[key].length < (key === "criteria" ? 6 : 12)) button(list, key === "criteria" ? "Add criterion" : "Add difficulty", () => {
        rubric[key].push({id: "", label: "", description: "", ...(key === "criteria" ? {max_score: 4} : {})});
        dirty();
        render();
      });
      panel.append(list);
    }
    button(panel, "Remove rubric", () => { delete task.writing_rubric; dirty(); render(); });
  }
  panel.open = !!rubric;
  parent.append(panel);
}

function renderMaterialEditor(parent, owner, limit, title = "Input materials", key = "materials") {
  const items = owner[key] ||= [];
  const panel = document.createElement("details");
  panel.open = !!items.length;
  const summary = document.createElement("summary");
  summary.textContent = title + (items.length ? " (" + items.length + ")" : "");
  panel.append(summary);
  items.forEach((item, index) => {
    const group = document.createElement("fieldset");
    const heading = document.createElement("legend");
    heading.textContent = "Material " + (index + 1);
    group.append(heading);
    field(group, "Type", item.kind, value => {
      item.kind = value;
      if (value === "text") delete item.url;
      render();
    }, ["text", "image", "audio", "video"]);
    if (item.kind !== "text") field(group, "Media URL (HTTPS)", item.url, value => { item.url = value.trim(); });
    field(group, item.kind === "text" ? "Text" : "Caption (optional)", item.text,
      value => { item.text = value; }, null, true);
    if (index > 0) button(group, "Move up", () => {
      [items[index - 1], items[index]] = [items[index], items[index - 1]];
      dirty();
      render();
    });
    button(group, "Remove material", () => { items.splice(index, 1); dirty(); render(); });
    panel.append(group);
  });
  if (items.length < limit) button(panel, "Add material", () => {
    items.push({kind: "text", text: ""});
    dirty();
    render();
  });
  parent.append(panel);
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
    renderMaterialEditor(group, question, 8);
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
  hasUnsavedChanges = true;
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
  lesson.blocks.push({ id: crypto.randomUUID(), phase: "teach", kind, title: kind === "slide" ? "New slide" : kind === "page" ? "New Page" : "New task" });
  selected = lesson.blocks.length - 1;
  selectedElement = null;
  revealPreview = -1;
  dirty();
  render();
}

byId("up").onclick = () => move(-1);
byId("down").onclick = () => move(1);
byId("remove").onclick = () => {
  if (lesson.blocks.length < 2) return;
  lesson.blocks.splice(selected, 1);
  selectedElement = null;
  revealPreview = -1;
  selected = Math.min(selected, lesson.blocks.length - 1);
  dirty();
  render();
};
byId("addSlide").onclick = () => add("slide");
byId("addPage").onclick = () => add("page");
byId("addTask").onclick = () => add("writing");
byId("course").onchange = dirty;
byId("level").onchange = dirty;
byId("title").oninput = dirty;
byId("objective").oninput = dirty;
byId("googleSlidesImport").onsubmit = async event => {
  event.preventDefault();
  if (lesson && !confirm("Replace the current draft with the imported slides?")) return;
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  submit.disabled = true;
  status("Importing Google Slides…");
  try {
    const imported = await request("/slides/import", { url: form.elements.url.value.trim() });
    const deck = await request("/" + imported.lesson_path);
    loadDraft({
      schema_version: 1,
      title: deck.title,
      blocks: deck.blocks.map(block => ({
        id: block.id,
        title: block.title,
        kind: "slide",
        phase: "teach",
        elements: [{
          kind: "image", text: block.title, url: api + "/" + block.image_path,
          x: 0, y: 0, width: 100, height: 100
        }]
      }))
    });
    catalogueId = null;
    const url = new URL(location.href);
    url.searchParams.delete("revision");
    url.searchParams.delete("catalogue");
    history.replaceState({}, "", url);
    status("Slides imported. Set the course, level and title, then save a version.");
  } catch (error) {
    status(error.message);
  } finally {
    submit.disabled = false;
  }
};
byId("import").onclick = () => {
  try { loadDraft(JSON.parse(byId("source").value)); status("Draft imported. Review and save a version."); }
  catch (error) { status(error.message); }
};
byId("sample").onclick = async () => {
  if (hasUnsavedChanges && !window.confirm("Replace the unsaved changes in this draft?")) return;
  try {
    const response = await fetch("work-lesson-sample.json");
    loadDraft(await response.json());
    catalogueId = null;
    history.replaceState(null, "", location.pathname);
    status("New Work started from the sample. Edit it and save a version.");
  } catch (error) { status(error.message); }
};
const publishedQuery = byId("publishedQuery");
const publishedResults = byId("publishedResults");
const publishedStatus = byId("publishedStatus");
const searchPublished = byId("searchPublished");
let publishedEntries = [];

function renderPublishedLessons() {
  const terms = publishedQuery.value.toLowerCase().trim().split(/\s+/);
  const matches = publishedEntries.filter(item => {
    const label = [item.title, item.course, item.level, item.cluster].join(" ").toLowerCase();
    return terms.every(term => label.includes(term));
  });
  publishedResults.replaceChildren();
  for (const item of matches.slice(0, 30)) {
    const row = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Edit " + item.title;
    open.onclick = () => openPublishedLesson(item);
    row.append(open, [item.course, item.level && "Level " + item.level, item.cluster].filter(Boolean).join(" · "));
    publishedResults.append(row);
  }
  publishedStatus.textContent = matches.length > 30
    ? "Showing 30 of " + matches.length + " lessons. Refine your search."
    : matches.length ? matches.length + " published lesson(s)." : "No editable published lessons found.";
}

searchPublished.onclick = async () => {
  if (!byId("token").value.trim()) {
    publishedStatus.textContent = "Enter the staging teacher access code first.";
    byId("token").focus();
    return;
  }
  searchPublished.disabled = true;
  publishedStatus.textContent = "Loading published lessons…";
  publishedResults.replaceChildren();
  publishedEntries = [];
  const token = byId("token").value.trim();
  try {
    const entries = new Map();
    for (let offset = 0; ; offset += 50) {
      const result = await request("/lesson-catalogue?offset=" + offset);
      if (token !== byId("token").value.trim()) return;
      for (const item of result.entries) {
        if (item.origin === "work") entries.set(item.catalogue_id, item);
      }
      if (!result.has_more) break;
    }
    publishedEntries = [...entries.values()];
    renderPublishedLessons();
  } catch (error) {
    publishedStatus.textContent = error.message;
  } finally {
    searchPublished.disabled = false;
  }
};

publishedQuery.oninput = () => {
  if (publishedEntries.length) renderPublishedLessons();
};
publishedQuery.onkeydown = event => {
  if (event.key === "Enter") searchPublished.click();
};
byId("token").addEventListener("input", () => {
  publishedEntries = [];
  publishedResults.replaceChildren();
  publishedStatus.textContent = "";
});

let openingPublishedLesson = false;
async function openPublishedLesson(item) {
  if (openingPublishedLesson || byId("save").disabled) return;
  openingPublishedLesson = true;
  const token = byId("token").value.trim();
  try {
    const current = await request("/lesson-catalogue/" + encodeURIComponent(item.catalogue_id));
    const result = await request("/work-lessons/" + encodeURIComponent(current.revision_id));
    if (token !== byId("token").value.trim() || byId("save").disabled) return;
    if (hasUnsavedChanges && !window.confirm("Replace the unsaved changes in this draft?")) return;
    loadDraft(result.lesson, current.revision_id);
    catalogueId = item.catalogue_id;
    const url = new URL(location.href);
    url.searchParams.set("revision", revision);
    url.searchParams.set("catalogue", catalogueId);
    history.replaceState(null, "", url);
    setPublishedSearchOpen(false);
    status("Published version " + result.version + " loaded for editing.");
    byId("title").focus();
  } catch (error) {
    publishedStatus.textContent = error.message;
  } finally {
    openingPublishedLesson = false;
  }
}

function setPublishedSearchOpen(open) {
  byId("publishedLessons").hidden = !open;
  byId("findPublished").setAttribute("aria-expanded", String(open));
  if (open) publishedQuery.focus();
}
byId("findPublished").onclick = () => setPublishedSearchOpen(byId("publishedLessons").hidden);

const linkedRevision = authorParams.get("revision");
let loadingLinkedRevision = false;
async function loadLinkedRevision() {
  const token = byId("token").value.trim();
  if (!linkedRevision || lesson || !token || loadingLinkedRevision) return;
  loadingLinkedRevision = true;
  try {
    const result = await request("/work-lessons/" + encodeURIComponent(linkedRevision));
    if (lesson || token !== byId("token").value.trim()) return;
    loadDraft(result.lesson, linkedRevision);
    status("Version " + result.version + " loaded.");
  } catch (error) {
    if (!lesson && token === byId("token").value.trim()) status(error.message);
  } finally {
    loadingLinkedRevision = false;
    if (token !== byId("token").value.trim()) void loadLinkedRevision();
  }
}
if (linkedRevision) {
  status("Enter the staging teacher access code to open this version.");
  let loadTimer;
  byId("token").addEventListener("input", () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadLinkedRevision, 500);
  });
  byId("token").addEventListener("keydown", event => {
    if (event.key === "Enter") void loadLinkedRevision();
  });
  void loadLinkedRevision();
}
byId("save").onclick = async () => {
  byId("save").disabled = true;
  try {
    lesson.course = byId("course").value || null;
    lesson.level = Number(byId("level").value) || null;
    lesson.title = byId("title").value.trim();
    lesson.objective = byId("objective").value.trim();
    const blocks = lesson.blocks.map(block => {
      const copy = { ...block };
      if (copy.kind !== "multiple_choice") delete copy.quiz;
      if (copy.kind !== "writing") delete copy.writing_rubric;
      if (!isTextAssessment(copy.kind)) delete copy.text_questions;
      if (!isOrdering(copy.kind)) delete copy.ordering_questions;
      if (copy.kind !== "page") delete copy.tasks;
      if (copy.kind !== "dialogue") {
        delete copy.role_a;
        delete copy.role_b;
        delete copy.role_a_materials;
        delete copy.role_b_materials;
      }
      return copy;
    });
    const saved = await request("/work-lessons", { lesson: { ...lesson, blocks }, parent_revision: revision });
    revision = saved.revision;
    hasUnsavedChanges = false;
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



function addCanvasElement(kind) {
  const block = lesson?.blocks[selected];
  if (!block || !["slide", "page"].includes(block.kind)) return;
  const elements = block.elements ||= [];
  if (elements.length >= 60) return status("A slide can contain up to 60 elements.");
  const text = {text:"New text", image:"Image", audio:"", shape:"", icon:"★", table:""}[kind];
  selectedElement = {kind,text,x:10,y:10,width:30,height:16,appear:0};
  if (kind === "table") {
    selectedElement.width = 45;
    selectedElement.height = 30;
    selectedElement.cells = [["Heading 1","Heading 2"],["",""]];
  }
  elements.push(selectedElement);
  revealPreview = -1;
  dirty();
  render();
}
for (const control of document.querySelectorAll("[data-add-element]")) {
  control.onclick = () => addCanvasElement(control.dataset.addElement);
}
byId("previewReveal").onchange = () => {
  revealPreview = Number(byId("previewReveal").value);
  renderPreview();
};

function renderInspector() {
  const panel = byId("elementInspector");
  panel.replaceChildren();
  const block = lesson.blocks[selected];
  const elements = block.elements || [];
  if (!elements.length) return;
  const heading = document.createElement("h3");
  heading.textContent = "Element properties";
  panel.append(heading);
  const layer = document.createElement("select");
  layer.setAttribute("aria-label", "Select slide element");
  layer.add(new Option("Select an element", ""));
  elements.forEach((element,index) => layer.add(new Option(
    (index + 1) + ". " + element.kind + (element.text ? " · " + element.text : ""), String(index))));
  layer.value = elements.includes(selectedElement) ? String(elements.indexOf(selectedElement)) : "";
  layer.onchange = () => {
    selectedElement = layer.value === "" ? null : elements[Number(layer.value)];
    revealPreview = -1;
    renderInspector();
    renderPreview();
  };
  panel.append(layer);
  const element = selectedElement;
  if (!elements.includes(element)) return;
  field(panel, element.kind === "audio" ? "Audio label (optional; blank = icon only)" : "Text or accessible label",
    element.text, value => { element.text = value; });
  if (element.kind !== "image") {
    field(panel, "Font", element.font_family || "", value => { element.font_family = value || null; },
      ["","system-ui","Arial","Verdana","Georgia","Trebuchet MS","Courier New"]);
    numericStyle(panel, element, "font_size", "Font size (12–120 px at 1280px)", 12, 120, null);
    field(panel, "Text color", element.text_color || (element.kind === "audio" ? "#ffffff" : "#172338"),
      value => { element.text_color = value; }, null, false, false, "color");
  }
  if (element.kind === "text") {
    for (const [key, title] of [["bold", "Bold"], ["italic", "Italic"], ["underline", "Underline"]]) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(element[key]);
      checkbox.onchange = () => {
        element[key] = checkbox.checked || null;
        dirty();
        renderPreview();
      };
      label.append(checkbox, " " + title);
      panel.append(label);
    }
    field(panel, "Text alignment", element.text_align || "center", value => {
      element.text_align = value;
    }, ["left", "center", "right"]);
    field(panel, "List (one item per line)", element.list_style || "", value => {
      element.list_style = value || null;
    }, ["", "bullet", "numbered"]);
  }
  if (element.kind === "shape") {
    field(panel, "Shape", element.shape || "rectangle", value => {
      element.shape = value;
      renderInspector();
    }, ["rectangle","circle","arrow","line"]);
    if (element.shape !== "line") {
      field(panel, "Fill color", element.fill_color || "#d5e6ff",
        value => { element.fill_color = value; }, null, false, false, "color");
      numericStyle(panel, element, "fill_opacity", "Fill opacity (%)", 0, 100, 100);
    }
    field(panel, "Border / line color", element.border_color || "#7aa6dd",
      value => { element.border_color = value; }, null, false, false, "color");
    numericStyle(panel, element, "border_opacity", "Border / line opacity (%)", 0, 100, 100);
    numericStyle(panel, element, "border_width", "Border / line width (px)", 1, 20, 2);
  }
  if (element.kind === "table") editTable(panel, element);
  if (element.kind === "image" || element.kind === "audio") field(panel, "Direct HTTPS URL", element.url,
    value => { element.url = value.trim(); });
  for (const [key,label] of [["x","Left (%)"],["y","Top (%)"],["width","Width (%)"],["height","Height (%)"],
    ["appear","Appear on reveal"],["disappear","Disappear on reveal (optional)"]]) {
    field(panel,label,element[key] ?? (key === "appear" ? 0 : ""),value => {
      element[key] = key === "disappear" && !value.trim() ? null : Number(value);
    });
  }
  const index = elements.indexOf(element);
  function moveLayer(delta) {
    const next = index + delta;
    if (next < 0 || next >= elements.length) return;
    [elements[index],elements[next]] = [elements[next],elements[index]];
    dirty();
    render();
  }
  button(panel,"Send backward",() => moveLayer(-1));
  panel.lastChild.disabled = index === 0;
  button(panel,"Bring forward",() => moveLayer(1));
  panel.lastChild.disabled = index === elements.length - 1;
  button(panel,"Remove element",() => { elements.splice(index,1); selectedElement = null; dirty(); render(); });
}

function numericStyle(panel, element, key, label, min, max, fallback) {
  field(panel, label, element[key] ?? fallback, value => {
    if (value === "") {
      if (fallback === null) element[key] = null;
      return;
    }
    const number = Number(value);
    if (Number.isInteger(number) && number >= min && number <= max) element[key] = number;
  }, null, false, false, "number");
  const input = panel.lastChild.querySelector("input");
  input.min = min;
  input.max = max;
  input.addEventListener("change", () => { input.value = element[key] ?? fallback ?? ""; });
}

function editTable(panel, element) {
  const rows = element.cells;
  const header = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = element.header_row !== false;
  checkbox.onchange = () => { element.header_row = checkbox.checked; dirty(); renderPreview(); };
  header.append(checkbox, " Header row");
  panel.append(header);
  function editStructure(label, disabled, change) {
    button(panel, label, () => { change(); dirty(); renderInspector(); renderPreview(); });
    panel.lastChild.disabled = disabled;
  }
  editStructure("+ Row", rows.length >= 12, () => rows.push(Array(rows[0].length).fill("")));
  editStructure("+ Column", rows[0].length >= 8, () => rows.forEach(row => row.push("")));
  editStructure("Remove last row", rows.length <= 1, () => rows.pop());
  editStructure("Remove last column", rows[0].length <= 1, () => rows.forEach(row => row.pop()));
  for (const [i, row] of rows.entries()) {
    const group = document.createElement("fieldset");
    const heading = document.createElement("legend");
    heading.textContent = "Row " + (i + 1);
    group.append(heading);
    row.forEach((cell,j) => {
      field(group, "Column " + (j + 1), cell, value => { row[j] = value; });
      group.lastChild.querySelector("input").maxLength = 300;
    });
    panel.append(group);
  }
}

function renderElements(fields, block) {
  const importPanel = document.createElement("details");
  const importTitle = document.createElement("summary");
  importTitle.textContent = "Import element layout JSON";
  importPanel.append(importTitle);
  const input = document.createElement("textarea");
  input.rows = 5;
  input.setAttribute("aria-label", "Element layout JSON");
  importPanel.append(input);
  button(importPanel, "Apply layout", () => {
    try {
      const layout = JSON.parse(input.value);
      if (!Array.isArray(layout) || layout.length > 60 || layout.some(element => !element ||
          !["text","image","audio","shape","icon","table"].includes(element.kind) ||
          !validTable(element))) {
        throw new Error("Use an array of up to 60 slide elements.");
      }
      block.elements = layout;
      selectedElement = null;
      revealPreview = -1;
      dirty();
      render();
      status("Element layout applied. Save a version to keep it.");
    } catch (error) {
      status(error.message);
    }
  });
  fields.append(importPanel);
}
