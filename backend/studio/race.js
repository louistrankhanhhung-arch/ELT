(() => {
  const id = new URLSearchParams(location.search).get("id");
  const el = name => document.getElementById(name);
  const colors = ["#286340", "#17647b", "#9c501c", "#6d4982"];
  const lanes = new Map();
  let timer;
  function node(tag, name, content) {
    const element = document.createElement(tag);
    if (name) element.className = name;
    if (content) element.textContent = content;
    return element;
  }
  function createLane(name, index) {
    const lane = node("section", "lane");
    const heading = node("header");
    const score = node("strong");
    heading.append(node("h2", "", name), score);
    const course = node("div", "course");
    course.setAttribute("aria-hidden", "true");
    const marker = node("span", "climber", name[0]);
    marker.style.setProperty("--team", colors[index]);
    course.append(node("div", "ridge"), node("div", "trail"), node("span", "finish", "⚑"), marker);
    lane.append(heading, course);
    el("lanes").append(lane);
    const result = {score, marker};
    lanes.set(name, result);
    return result;
  }
  async function refresh() {
    try {
      const response = await fetch(window.ELT_CONFIG.API_BASE + "/races/" + encodeURIComponent(id), {cache:"no-store"});
      if (response.status === 404) {
        el("status").textContent = "Race not found.";
        return;
      }
      if (!response.ok) throw new Error("Could not load race.");
      const data = await response.json();
      el("mode").textContent = data.mode === "accuracy" ? "Accuracy Race" : "Finish Together";
      el("status").textContent = data.status === "ended" ? "Race ended" : "Race in progress";
      data.teams.forEach((team, index) => {
        const lane = lanes.get(team.name) || createLane(team.name, index);
        lane.score.textContent = team.submitted + "/" + team.total + " submitted" +
          (team.accuracy == null ? "" : " · " + team.accuracy + "%");
        lane.marker.style.setProperty("--progress", team.submitted / team.total);
      });
      if (data.status === "ended") {
        el("winners").textContent = data.leaders.length ? (data.leaders.length > 1 ? "Joint leaders · " : "Winner · ") +
          data.leaders.join(" / ") : "No team reached the finish.";
        return;
      }
    } catch {
      el("status").textContent = "Reconnecting…";
    }
    timer = setTimeout(refresh, 1800);
  }
  window.addEventListener("pagehide", () => clearTimeout(timer));
  if (/^[a-f0-9]{32}$/.test(id || "")) void refresh();
  else el("status").textContent = "Open Race Screen from a live Classroom session.";
})();
