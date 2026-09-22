chrome.runtime.sendMessage({
  type: "page.ready",
  url: window.location.href,
  title: document.title,
});
