(() => {
  const playing = new WeakMap();
  function node(tag, value) {
    const item = document.createElement(tag);
    if (value) item.textContent = value;
    return item;
  }
  function mediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  window.renderVocab = (root, cards, title, step, interactive, settings) => {
    playing.get(root)?.pause();
    playing.delete(root);
    const deck = node("section");
    deck.className = "vocab-deck";
    deck.append(node("h2", title));
    const grid = node("div");
    grid.className = "vocab-grid";
    const recall = step === 2;
    const visibleCards = recall && settings?.order ? settings.order.map(index => cards[index]) : cards;
    for (const [index, card] of visibleCards.entries()) {
      const item = node("article");
      item.className = "vocab-card";
      const image = mediaUrl(card.image_url);
      if (image) {
        const picture = node("img");
        picture.alt = recall ? "Picture clue " + (index + 1) : card.term;
        picture.src = image;
        item.append(picture);
      }
      item.append(node("h3", recall ? String(index + 1) : card.term || "New word"));
      if (!recall && card.meaning) item.append(node("p", card.meaning));
      if (!recall && step !== 0 && card.example) item.append(node("p", card.example));
      const clips = [["Hear word", card.audio_url], ["Example", card.example_audio_url]];
      if (step !== 0 && (!recall || settings?.audio)) for (const [label, source] of clips) {
        const url = mediaUrl(source);
        if (!url) continue;
        const iconOnly = label === "Hear word";
        const play = node("button", iconOnly ? REHSlideStyle.audioLabel({}) : label);
        play.className = "reh-audio-button";
        play.title = label;
        play.type = "button";
        play.dataset.rehClip = "vocab-" + index + (iconOnly ? "-word" : "-example");
        play.disabled = !interactive && !settings?.allowClassAudio;
        play.setAttribute("aria-label", label + (recall ? " " + (index + 1) : ": " + card.term));
        play.onclick = () => {
          playing.get(root)?.pause();
          const audio = new Audio(url);
          playing.set(root, audio);
          play.setAttribute("aria-pressed", "false");
          audio.addEventListener("playing", () => play.setAttribute("aria-pressed", "true"));
          for (const event of ["pause", "ended"]) {
            audio.addEventListener(event, () => play.setAttribute("aria-pressed", "false"));
          }
          audio.play().catch(error => {
            if (error.name !== "AbortError" && playing.get(root) === audio) {
              if (error.name === "NotAllowedError") {
                play.title = "Tap to listen";
                play.setAttribute("aria-label", "Tap to listen: " + label);
                if (!iconOnly) play.textContent = "Tap to listen";
                return;
              }
              play.title = "Audio unavailable";
              play.setAttribute("aria-label", label + " (audio unavailable)");
              if (!iconOnly) play.textContent = "Audio unavailable";
            }
          });
        };
        item.append(play);
      }
      grid.append(item);
    }
    if (!cards.length) deck.append(node("p", "Add a vocab card in Properties."));
    deck.append(grid);
    root.replaceChildren(deck);
  };
})();
