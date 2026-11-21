let dailySdk;

function loadDailySdk() {
  if (!dailySdk) {
    dailySdk = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/@daily-co/daily-js@0.94.0";
      script.crossOrigin = "anonymous";
      script.onload = () => {
        if (window.Daily?.createFrame) resolve(window.Daily);
        else reject(new Error("Daily Video could not load."));
      };
      script.onerror = () => reject(new Error("Daily Video could not load. Try again."));
      document.head.append(script);
    }).catch(error => { dailySdk = null; throw error; });
  }
  return dailySdk;
}

window.createOnlineClass = (api, credentials, label) => {
  const panel = document.getElementById("onlineClass");
  const join = panel.querySelector("[data-video-join]");
  const leave = panel.querySelector("[data-video-leave]");
  const status = panel.querySelector("[data-video-status]");
  const frame = panel.querySelector("[data-video-frame]");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "online-class-handle";
  handle.textContent = "Class video";
  handle.title = "Drag to move, or use arrow keys";
  handle.setAttribute("aria-label", "Move class video with arrow keys");
  handle.hidden = true;
  panel.querySelector(".online-class-tools").prepend(handle);
  const size = document.createElement("button");
  size.type = "button";
  size.textContent = "Enlarge";
  size.hidden = true;
  leave.before(size);
  let generation = 0;
  let call;
  let cleanup = Promise.resolve();
  let drag;

  function move(left, top) {
    if (!panel.classList.contains("is-floating")) return;
    const gutter = 6;
    panel.style.left = Math.max(gutter, Math.min(left, window.innerWidth - panel.offsetWidth - gutter)) + "px";
    panel.style.top = Math.max(gutter, Math.min(top, window.innerHeight - panel.offsetHeight - gutter)) + "px";
  }
  function fit() {
    const {left, top} = panel.getBoundingClientRect();
    move(left, top);
  }
  window.addEventListener("resize", fit);
  size.onclick = () => {
    size.textContent = panel.classList.toggle("is-expanded") ? "Compact" : "Enlarge";
    fit();
  };
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    const {left, top} = panel.getBoundingClientRect();
    drag = {id: event.pointerId, x: event.clientX - left, y: event.clientY - top};
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (drag?.id === event.pointerId) move(event.clientX - drag.x, event.clientY - drag.y);
  });
  handle.addEventListener("lostpointercapture", () => { drag = null; });
  handle.addEventListener("keydown", event => {
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (!direction) return;
    event.preventDefault();
    const {left, top} = panel.getBoundingClientRect();
    move(left + 24 * direction[0], top + 24 * direction[1]);
  });
  join.textContent = label;

  function disconnect() {
    generation++;
    if (call) {
      const previous = call;
      call = null;
      cleanup = previous.destroy().catch(() => {});
    }
    frame.replaceChildren();
    panel.classList.remove("is-floating", "is-expanded");
    panel.style.left = panel.style.top = "";
    size.textContent = "Enlarge";
    size.hidden = handle.hidden = true;
    join.disabled = false;
    join.hidden = false;
    leave.hidden = true;
    status.textContent = "";
  }

  join.addEventListener("click", async () => {
    const {pin, headers, studentId} = credentials();
    if (!pin) return;
    const version = ++generation;
    join.disabled = true;
    status.textContent = "Connecting…";
    try {
      const role = studentId ? "join" : "host";
      const response = await fetch(api + "/sessions/" + encodeURIComponent(pin) + "/online-class/" + role, {
        method: "POST", cache: "no-store",
        headers: {...headers, "Content-Type": "application/json"},
        body: studentId ? JSON.stringify({student_id: studentId}) : undefined
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not open the video room.");
      if (version !== generation) return;
      const url = new URL(data.room_url);
      if (url.protocol !== "https:" || !/^[a-z0-9-]+\.daily\.co$/.test(url.hostname)) {
        throw new Error("Invalid Daily room.");
      }
      const daily = await loadDailySdk();
      await cleanup;
      if (version !== generation) return;
      panel.classList.add("is-floating");
      panel.open = true;
      size.hidden = handle.hidden = false;
      join.hidden = true;
      leave.hidden = false;
      const next = daily.createFrame(frame, {
        iframeStyle: {width: "100%", height: "100%", border: "0"},
        activeSpeakerMode: false,
        showLocalVideo: true,
        layoutConfig: {grid: {minTilesPerPage: 4, maxTilesPerPage: 4}},
        showLeaveButton: false
      });
      call = next;
      next.on("left-meeting", () => {
        if (call === next) disconnect();
      });
      await next.join({url: url.href, token: data.token});
      if (version !== generation) return;
      status.textContent = studentId ? "Mute your call mic before recording a Speaking task." : "";
    } catch (error) {
      if (version === generation) {
        disconnect();
        status.textContent = error.message;
      }
    } finally {
      if (version === generation) join.disabled = false;
    }
  });
  leave.addEventListener("click", disconnect);
  window.addEventListener("pagehide", disconnect);
  return {
    show() { panel.hidden = false; },
    open() {
      panel.hidden = false;
      panel.open = true;
      if (call) handle.focus();
      else if (!join.disabled) join.click();
    },
    close() { disconnect(); panel.open = false; panel.hidden = true; }
  };
};
