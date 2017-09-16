"use strict";
const {contextMenus, downloads, i18n, runtime, tabs, webRequest} = browser;

const APPLICATION_PDF_REGEXP = /^\s*(?:app[acilnot]+\/)?(?:x-)?pdf(?:;.*|\s*)?$/i;
const TEXT_HTML_REGEXP = /^\s*text\/html(?:;.*|\s*)?$/i;

// https://www.npmjs.com/package/base64-regex
const BASE64_REGEXP = /(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)/;

// https://stackoverflow.com/questions/23054475/javascript-regex-for-extracting-filename-from-content-disposition-header/23054920
const FILENAME_REGEXP = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i;

// https://dxr.mozilla.org/mozilla-central/source/netwerk/base/nsNetUtil.cpp#2389
const DISPOSITION_INLINE_REGEXP = /^\s*(?:inline(?:;.*|\s*)?|filename.*|)$/i;

let ignoreOnceUrls = new Map();
let filenames = new Map();

let ellipsis = "\u2026";

let events = ["onCompleted", "onErrorOccurred", "onBeforeRedirect"];

function addListeners(filter) {
  for (let event of events) {
    webRequest[event].addListener(check, filter);
  }
}

function removeListeners() {
  for (let event of events) {
    if (webRequest[event].hasListener(check)) {
      webRequest[event].removeListener(check);
    }
  }
}

function check(details) {
  if (filenames.has(details.url)) {
    if (details.redirectUrl) {
      filenames.set(details.redirectUrl, filenames.get(details.url));
    }
    filenames.delete(details.url);
  }
  else if (ignoreOnceUrls.has(details.url)) {
    if (details.redirectUrl) {
      ignoreOnceUrls.set(details.redirectUrl, true);
    }
    ignoreOnceUrls.delete(details.url);
  }
  removeListeners();

  if (details.redirectUrl) {
    addListeners({
      urls: [details.redirectUrl],
      tabId: details.tabId
    });
  }
}

runtime.onMessage.addListener((message, sender) => {
  if (!(message.url && sender.tab)) {
    return;
  }

  let url = message.url;
  if (ignoreOnceUrls.has(url)) {
    return;
  }

  if (filenames.has(url)) {
    return;
  }

  if (!message.hasOwnProperty("filename")) {
    ignoreOnceUrls.set(url, true);
  }
  else {
    filenames.set(url, message.filename);
  }

  addListeners({
    urls: [url],
    tabId: sender.tab.id
  });
});

contextMenus.onClicked.addListener(async (info, tab) => {
  let params = new URLSearchParams(info.frameUrl.split("?")[1]);
  let url = params.get("url");

  let filename;
  if (params.has("fname")) {
    filename = params.get("fname");
  }
  else {
    let m = url.match(/([^\/?#;]+)(?=$|[?#;])/);
    if (m != null && m.length > 1) {
      filename = m[1];
    }

    if ((!filename || !/\.pdfx?$/i.test(filename)) && url.includes("?")) {
      let params = new URLSearchParams(url.split("?")[1]);
      for (let value of params.values()) {
        if (/\.pdfx?$/i.test(value)) {
          filename = value;
          break;
        }
        else {
          let m = FILENAME_REGEXP.exec(value);
          if (m != null && m.length > 1) {
            if (m[0].toLowerCase().startsWith("filename*")) {
              filename = m[1].replace(/^.+'.*'/, "");
            }
            else {
              filename = m[1].replace(/^\s*\\?['"]?/, "").replace(/\\?['"]?\s*$/, "");
            }

            if (filename && BASE64_REGEXP.test(filename)) {
              filename = atob(BASE64_REGEXP.exec(filename)[0]);
            }
            break;
          }
        }
      }
    }
  }

  if (typeof filename == "string") {
    if (/%[0-9A-Fa-f]{2}/.test(filename)) {
      try {
        filename = decodeURIComponent(filename);
      }
      catch (ex) {
      }
    }

    if (!/\.pdfx?$/i.test(filename)) {
      filename += ".pdf"; 
    }

    if (/[\/\\|"*?:<>]/.test(filename)) {
      let platformInfo = await runtime.getPlatformInfo();
      if (platformInfo.os == "win") { // fix error on windows
        filename = filename.replace(/[\/\\|"*?:<>]/g, "_");
      }
    }
  }
  else {
    filename = "document.pdf";
  }

  downloads.download({
    url,
    filename,
    saveAs: true
  }).catch(error => {
    if (error.message != "Download canceled by the user") {
      throw error; // only display important errors :)
    }
  });
});

contextMenus.create({
  id: "context-savepdf",
  title: i18n.getMessage("contextMenuItemSavePDF") + ellipsis,
  contexts: ["page", "frame"],
  documentUrlPatterns: [
    "https://docs.google.com/viewer?url=*&pdf=true",
    "https://docs.google.com/viewerng/viewer?url=*&pdf=true"
  ]
});

function processHeaders(details) {
  if (details.tabId == tabs.TAB_ID_NONE || details.method !== "GET") {
    return;
  }

  if (details.url.startsWith("https://docs.google.com/")) {
    if (details.url.includes("viewer?url=", 24) ||
        details.url.includes("viewerng/viewer?url=", 24)) {
      // weird bug
      if (details.statusCode == 204) {
        return {
          redirectUrl: details.url
        };
      }
    }
    return;
  }

  if (details.statusCode !== 200) {
    return;
  }

  if (details.url.includes("viewer.googleusercontent.com/viewer/secure/pdf/") ||
      details.url.startsWith("https://accounts.google.com/") ||
      details.url.startsWith("https://clients6.google.com/") ||
      details.url.startsWith("https://content.googleapis.com/")) {
    return;
  }

  let contentTypeHeader = null;
  let contentDispositionHeader = null;
  for (let header of details.responseHeaders) {
    switch (header.name.toLowerCase()) {
      case "content-disposition":
        contentDispositionHeader = header;
        break;
      case "content-type":
        contentTypeHeader = header;
        break;
    }
  }

  let contentDisposition;
  if (contentDispositionHeader &&
      contentDispositionHeader.value) {
    contentDisposition = contentDispositionHeader.value;
  }

  let contentType;
  if (contentTypeHeader &&
      contentTypeHeader.value) {
    contentType = contentTypeHeader.value;
  }

  if (!contentDisposition && !contentType && !filenames.has(details.url)) {
    return;
  }

  if (details.type != "main_frame" &&
      typeof contentDisposition == "string" &&
      !DISPOSITION_INLINE_REGEXP.test(contentDisposition)) {
    return;
  }

  let filename = "", isAttachment = false;
  if (filenames.has(details.url)) {
    isAttachment = true; // there is a download attribute

    let value = "attachment";
    if (filenames.get(details.url) != "") {
      filename = filenames.get(details.url);
      value += `; filename="${filename}"`;
    }
    details.responseHeaders.push({ name: "Content-Disposition", value });
    filenames.delete(details.url);
  }

  if (!filename && contentDisposition) {
    let m = FILENAME_REGEXP.exec(contentDisposition);
    if (m != null && m.length > 1) {
      if (m[0].toLowerCase().startsWith("filename*")) {
        filename = m[1].replace(/^.+'.*'/, "");
        try {
          filename = decodeURIComponent(filename);
        }
        catch (ex) {
        }
      }
      else {
        if (/%[0-9A-Fa-f]{2}/.test(m[1])) {
          try {
            filename = decodeURIComponent(m[1]);
          }
          catch (ex) {
            filename = m[1];
          }
        }
        else {
          filename = m[1].replace(/^\s*\\?['"]?/, "").replace(/\\?['"]?\s*$/, "");
        }

        if (filename != "") {
          if (/\s/.test(filename) && (!m[2] || m[2] != "\"")) {
            // fix firefox bug :(
            // https://bugzilla.mozilla.org/show_bug.cgi?id=221028
            contentDisposition = contentDisposition.replace(m[1], `"${filename}"`);
          }

          if (BASE64_REGEXP.test(filename)) {
            filename = atob(BASE64_REGEXP.exec(filename)[0]);
          }
        }
      }
    }
  }

  if (ignoreOnceUrls.has(details.url)) {
    ignoreOnceUrls.delete(details.url);

    if (contentDispositionHeader != null) {
      if (contentDisposition) {
        if (/^\s*inline/i.test(contentDisposition)) {
          contentDisposition = contentDisposition.replace(/^\s*inline/i, "attachment");
        }
        else if (/^\s*filename/i.test(contentDisposition)) {
          contentDisposition = contentDisposition.replace(/^\s*(filename)/i, "attachment; $1");
        }
        contentDispositionHeader.value = contentDisposition;
      }
    }
    else {
      details.responseHeaders.push({ name: "Content-Disposition", value: "attachment" });
    }

    return {
      responseHeaders: details.responseHeaders
    };
  }

  let isPDF = false;
  if (typeof contentType == "string") {
    if (APPLICATION_PDF_REGEXP.test(contentType)) {
      isPDF = true;
    }
    else if (!TEXT_HTML_REGEXP.test(contentType)) {
      if (/^[^?#;]+\.pdfx?(?=$|[#?;])/i.test(details.url)) {
        isPDF = true;
      }
    }
  }

  if (!isPDF && filename != "" &&
      /\.pdfx?$/i.test(filename)) {
    isPDF = true;
  }

  if (isPDF != true) {
    if (isAttachment != false) {
      return {
        responseHeaders: details.responseHeaders
      };
    }
    return;
  }

  let redirectUrl = "https://docs.google.com/viewer";
  try {
    redirectUrl += `?url=${encodeURIComponent(details.url)}`;
  }
  catch (ex) {
    redirectUrl += `?url=${details.url}`;
  }

  if (filename != "") {
    try {
      redirectUrl += `&fname=${encodeURIComponent(filename)}`;
    }
    catch (ex) {
      redirectUrl += `&fname=${filename}`;
    }
  }

  if (details.type == "xmlhttprequest") {
    tabs.update(details.tabId, {
      url: redirectUrl + "&pdf=true"
    });
    return {cancel: true};
  }
  else if (details.type == "sub_frame" || details.type == "object") {
    redirectUrl += "&embedded=true&pdf=true";
    return {redirectUrl};
  }
  redirectUrl += "&pdf=true";

  return new Promise(async resolve => {
    let tab = await tabs.get(details.tabId);
    if (/^wyciwyg:\/{2}\d+\//.test(tab.url)) {
      let url = tab.url.replace(/^wyciwyg:\/{2}\d+\//, "");
      if (url.startsWith("https://docs.google.com/viewer?url=") ||
          url.startsWith("https://docs.google.com/viewerng/viewer?url=")) {
        if (typeof contentDisposition == "string" &&
            contentDispositionHeader.value != contentDisposition) {
          contentDispositionHeader.value = contentDisposition;
          resolve({responseHeaders: details.responseHeaders});
        }
        else {
          resolve();
        }
      }
      else {
        resolve({redirectUrl});
      }
    }
    else {
      if (tab.url == details.url) {
        try {
          let [result] = await tabs.executeScript(tab.id, {
            code: `document.contentType == "application/pdf" && document.domain == "pdf.js"`
          });

          if (result == true) {
            resolve(); /* allow reloading on built-in pdf viewer page */
          }
          else {
            resolve({redirectUrl});
          }
        }
        catch (err) {
          console.error(err);
          resolve({redirectUrl});
        }
      }
      else {
        resolve({redirectUrl});
      }
    }
  });
}

webRequest.onHeadersReceived.addListener(
  processHeaders,
  {urls: ["*://*/*"], types: ["main_frame", "sub_frame", "xmlhttprequest", "object"]},
  ["blocking", "responseHeaders"]
);
