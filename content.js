"use strict"; 
function onClick(event) {
  if (!event.isTrusted || event.defaultPrevented || event.button != 0) {
    return;
  }

  if (event.ctrlKey || event.shiftKey ||
      event.metaKey || event.altKey) {
    return;
  }

  let node = event.target;
  if (node instanceof HTMLBodyElement ||
      node instanceof HTMLHtmlElement) {
    return;
  }

  let link = null;
  do {
   if (node instanceof HTMLAnchorElement ||
       node instanceof HTMLAreaElement ||
       node instanceof SVGAElement) {
     link = node;
   }
   else {
     node = node.parentElement;
     if (!node || node instanceof HTMLBodyElement) {
       break;
     }
   }
  }
  while (link == null);

  if (!link || !link.hasAttribute("download")) {
    return;
  }

  let url = link.href;
  if (url) {
    // Handle SVG links:
    if (typeof url == "object" && url.animVal) {
      url = url.animVal;
    }
  }

  if (!url) {
    let href = link.getAttribute("href") ||
               link.getAttributeNS("http://www.w3.org/1999/xlink", "href");

    if (href && /\S/.test(href)) {
      url = new URL(href, link.baseURI).href;
    }
  }

  if (!url || !/^https?:/i.test(url)) {
    return;
  }

  let origin = link.origin;
  if (!origin) {
    origin = new URL(url).origin;
  }

  if (origin != window.location.origin) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();

  browser.runtime.sendMessage({
    url,
    "filename": link.download.trim()
  }).then(() => {
    window.location.href = url;
  }).catch(error => {
    console.error(error);
    link.click();
  });
}

if (window.origin != "resource://pdf.js") {
  window.addEventListener("click", onClick, true);
}
