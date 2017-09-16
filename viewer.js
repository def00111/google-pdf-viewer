"use strict";
let params = new URLSearchParams(document.URL.split("?")[1]);

let url = params.get("url");

function onBtnClick(event) {
  browser.runtime.sendMessage({
    url
  }).then(() => {
    window.location.href = url;
  });
  event.preventDefault();
}

function modifyPage() {
  let button = document.querySelector("div.ndfHFb-c4YZDc-bN97Pc-nupQLb-LgbsSe[role=button]");
  if (button) {
    if (button.style.display != "") {
      button.style.display = "";
      button.addEventListener("click", onBtnClick, true);
    }
    return true;
  }
  return false;
}
 
if (!modifyPage()) {
  let callback = () => {
    if (modifyPage()) {
      observer.disconnect();
    }
  };

  let observer = new MutationObserver(callback);
  observer.observe(document, { childList: true, subtree: true });
}
