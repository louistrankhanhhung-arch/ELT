(() => {
  function mediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url : null;
    } catch { return null; }
  }
  function youtubeId(url) {
    if (url.hostname === "youtu.be") return url.pathname.split("/")[1];
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"].includes(url.hostname)) {
      return url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
    }
  }
  window.renderTaskMaterials = (parent, materials) => {
    if (!materials?.length) return;
    const list = document.createElement("div");
    list.className = "task-materials";
    for (const item of materials) {
      if (item.kind === "text") {
        const paragraph = document.createElement("p");
        paragraph.textContent = item.text;
        list.append(paragraph);
        continue;
      }
      const url = mediaUrl(item.url);
      if (!url || !["image", "audio", "video"].includes(item.kind)) continue;
      const id = item.kind === "video" && youtubeId(url);
      const embedded = /^[A-Za-z0-9_-]{11}$/.test(id || "");
      const figure = document.createElement("figure");
      const media = document.createElement(embedded ? "iframe" : item.kind === "image" ? "img" : item.kind);
      if (embedded) {
        media.src = "https://www.youtube-nocookie.com/embed/" + id;
        media.title = item.text || "Task video";
        media.allowFullscreen = true;
        media.loading = "lazy";
      } else {
        media.src = url.href;
        if (item.kind === "image") media.alt = item.text || "";
        else {
          media.controls = true;
          media.preload = "metadata";
          if (item.kind === "video") media.playsInline = true;
        }
      }
      figure.append(media);
      if (item.text) {
        const caption = document.createElement("figcaption");
        caption.textContent = item.text;
        figure.append(caption);
      }
      list.append(figure);
    }
    if (list.childElementCount) parent.append(list);
  };
})();
