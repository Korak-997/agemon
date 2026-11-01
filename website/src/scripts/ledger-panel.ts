for (const panel of document.querySelectorAll<HTMLElement>(
  "[data-ledger-panel]",
)) {
  const toggle = panel.querySelector<HTMLButtonElement>("[data-ledger-nuke]");
  const note = panel.querySelector("[data-ledger-note]");
  const addedPaths = panel.querySelector(".added-paths");
  const label = toggle?.querySelector("code");
  if (!toggle || !note || !addedPaths || !label) continue;

  toggle.addEventListener("click", () => {
    const nuked = !panel.hasAttribute("data-nuked");
    panel.toggleAttribute("data-nuked", nuked);
    addedPaths.toggleAttribute("aria-hidden", nuked);
    label.textContent = nuked ? "Reset the view" : "agemon nuke";
    note.textContent = nuked ? "your files only" : "";
  });
}
