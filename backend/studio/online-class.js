window.createOnlineClass = (api, credentials, label) => {
  const panel = document.getElementById("onlineClass");
  const join = panel.querySelector("[data-video-join]");
  const leave = panel.querySelector("[data-video-leave]");
  const status = panel.querySelector("[data-video-status]");
  const frame = panel.querySelector("[data-video-frame]");
  let generation = 0;
  join.textContent = label;

  function disconnect() {
    generation++;
    frame.replaceChildren();
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
      url.searchParams.set("t", data.token);
      const iframe = document.createElement("iframe");
      iframe.title = "Daily classroom video call";
      iframe.allow = "camera; microphone; autoplay; display-capture; fullscreen";
      iframe.referrerPolicy = "no-referrer";
      iframe.src = url.href;
      frame.replaceChildren(iframe);
      join.hidden = true;
      leave.hidden = false;
      status.textContent = studentId ? "Mute your call mic before recording a Speaking task." : "";
    } catch (error) {
      if (version === generation) status.textContent = error.message;
    } finally {
      if (version === generation) join.disabled = false;
    }
  });
  leave.addEventListener("click", disconnect);
  window.addEventListener("pagehide", disconnect);
  return {
    show() { panel.hidden = false; },
    close() { disconnect(); panel.open = false; panel.hidden = true; }
  };
};
