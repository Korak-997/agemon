const COPIED_MESSAGE_MS = 2000;

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "button[data-copy]",
)) {
  const status = button.nextElementSibling;
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
    button.dataset.copied = "";
    if (status) status.textContent = "Copied to clipboard";
    setTimeout(() => {
      delete button.dataset.copied;
      if (status) status.textContent = "";
    }, COPIED_MESSAGE_MS);
  });
}
