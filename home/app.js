for (const button of document.querySelectorAll("[data-copy-command]")) {
  button.addEventListener("click", async () => {
    const command = button.getAttribute("data-copy-command");
    if (!command) return;

    await navigator.clipboard.writeText(command);
    const label = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = label;
    }, 1500);
  });
}
