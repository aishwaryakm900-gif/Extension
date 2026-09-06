const statusElement = document.querySelector<HTMLDivElement>(".status");
const openPdf = document.querySelector<HTMLButtonElement>("#open-pdf");

if (statusElement) {
  statusElement.setAttribute("aria-label", "Reader AI is ready");
}

openPdf?.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://localhost:3000/reader/pdf" });
  window.close();
});
