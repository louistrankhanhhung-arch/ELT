let dailySdk;

function loadDailySdk() {
  if (!dailySdk) {
    dailySdk = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/@daily-co/daily-js@0.94.0";
      script.crossOrigin = "anonymous";
      const timer = setTimeout(() => {
        script.remove();
        reject(new Error("Daily Video took too long to load. Try again."));
      }, 12000);
      script.onload = () => {
        clearTimeout(timer);
        if (window.Daily?.createFrame) resolve(window.Daily);
        else reject(new Error("Daily Video could not load."));
      };
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error("Daily Video could not load. Try again."));
      };
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
  size.className = "online-class-icon";
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "online-class-icon";
  collapse.hidden = true;
  leave.before(collapse);
  leave.textContent = "Disconnect";

  function icon(button, path, label) {
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="' + path + '"/></svg>';
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function updateButtons() {
    const expanded = panel.classList.contains("is-expanded");
    const collapsed = panel.classList.contains("is-collapsed");
    icon(size, expanded ? "M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5" : "M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5",
      expanded ? "Compact video" : "Enlarge video");
    icon(collapse, collapsed ? "m6 9 6 6 6-6" : "M5 12h14", collapsed ? "Show video" : "Collapse video");
    collapse.setAttribute("aria-expanded", String(!collapsed));
    size.hidden = collapsed || handle.hidden;
  }

  updateButtons();
  size.hidden = true;
  leave.before(size);
  let generation = 0;
  let call;
  let mount;
  let cleanup = Promise.resolve();
  let drag;

  function move(left, top) {
    if (!panel.classList.contains("is-floating")) return;
    const gutter = 6;
    panel.style.right = panel.style.bottom = "auto";
    panel.style.left = Math.max(gutter, Math.min(left, window.innerWidth - panel.offsetWidth - gutter)) + "px";
    panel.style.top = Math.max(gutter, Math.min(top, window.innerHeight - panel.offsetHeight - gutter)) + "px";
  }
  function fit() {
    const {left, top} = panel.getBoundingClientRect();
    move(left, top);
  }
  window.addEventListener("resize", fit);
  size.onclick = () => {
    panel.classList.toggle("is-expanded");
    updateButtons();
    fit();
  };
  collapse.onclick = () => {
    panel.classList.toggle("is-collapsed");
    updateButtons();
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
      const previousMount = mount;
      mount = null;
      previousMount.hidden = true;
      let timeout;
      cleanup = Promise.race([
        Promise.resolve().then(() => previous.destroy()).catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, 1500); })
      ]).finally(() => {
        clearTimeout(timeout);
        previousMount.remove();
      });
    }
    if (mount) {
      mount.remove();
      mount = null;
    }
    panel.classList.remove("is-floating", "is-expanded", "is-prejoin", "is-collapsed");
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = "";
    size.hidden = handle.hidden = collapse.hidden = true;
    updateButtons();
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
      const [daily, response] = await Promise.all([loadDailySdk(), fetch(api + "/sessions/" + encodeURIComponent(pin) + "/online-class/" + role, {
        method: "POST", cache: "no-store",
        headers: {...headers, "Content-Type": "application/json"},
        body: studentId ? JSON.stringify({student_id: studentId}) : undefined
      })]);
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not open the video room.");
      if (version !== generation) return;
      const url = new URL(data.room_url);
      if (url.protocol !== "https:" || !/^[a-z0-9-]+\.daily\.co$/.test(url.hostname)) {
        throw new Error("Invalid Daily room.");
      }
      await cleanup;
      if (version !== generation) return;
      panel.classList.add("is-floating", "is-prejoin");
      panel.open = true;
      handle.hidden = collapse.hidden = false;
      updateButtons();
      join.hidden = true;
      leave.hidden = false;
      mount = document.createElement("div");
      mount.className = "online-class-mount";
      frame.append(mount);
      const next = daily.createFrame(mount, {
        allowMultipleCallInstances: true,
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
      next.on("joined-meeting", () => {
        if (call !== next || version !== generation) return;
        panel.classList.remove("is-prejoin");
        fit();
        status.textContent = studentId ? "Mute your call mic before recording a Speaking task." : "";
      });
      status.textContent = "";
      await next.join({url: url.href, token: data.token});
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
      if (call) {
        panel.classList.remove("is-collapsed");
        updateButtons();
        fit();
        handle.focus();
      } else if (!join.disabled) join.click();
    },
    close() { disconnect(); panel.open = false; panel.hidden = true; }
  };
};
