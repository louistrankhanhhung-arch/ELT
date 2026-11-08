window.ELT_CONFIG={API_BASE:"https://precious-cat-staging.up.railway.app/api",BASE_URL:new URL(".",document.currentScript.src).href,MEDIA_BASE:"https://media.rootenglishhouse.com",TEACHER_PIN:"2468"};

window.runtimeLessonUrl = function (path) {
  const base = /^imports\/[a-f0-9]{32}$/.test(path)
    ? window.ELT_CONFIG.API_BASE + "/"
    : window.ELT_CONFIG.BASE_URL;
  return base + path;
};
window.runtimePlayerUrl = function (block, role) {
  const config = window.ELT_CONFIG;
  if (block.image_path) {
    const player = new URL("player-imported-slide.html", config.BASE_URL);
    player.searchParams.set("image", block.image_path);
    return player.href;
  }
  const player = new URL(config.BASE_URL + block.player);
  player.searchParams.set("data", config.BASE_URL + block.data);
  player.searchParams.set("role", role);
  return player.href;
};

