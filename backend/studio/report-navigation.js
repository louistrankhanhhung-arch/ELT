document.querySelectorAll("button[data-page]").forEach(button => {
  button.addEventListener("click", () => location.assign(button.dataset.page));
});
