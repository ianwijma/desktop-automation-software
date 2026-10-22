const port = document.querySelector("#port"),
  token = document.querySelector("#token"),
  status = document.querySelector("#status");
chrome.storage.local.get(["port", "token", "status"]).then((value) => {
  port.value = value.port || "";
  token.value = value.token || "";
  status.textContent = value.status || "Not paired";
});
document.querySelector("#pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    port: Number(port.value),
    token: token.value.trim(),
    status: "Connecting…",
  });
  await chrome.runtime.sendMessage({ type: "pair" });
  status.textContent = "Connecting…";
});
document.querySelector("#disconnect").addEventListener("click", async () => {
  await chrome.storage.local.remove(["port", "token"]);
  status.textContent = "Disconnected";
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) status.textContent = changes.status.newValue;
});
