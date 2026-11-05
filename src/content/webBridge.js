// Ponte entre o site GuardIAn (landing + dashboard) e a extensão.
// O service worker só responde se a aba pertencer ao mesmo domínio do backend configurado.
(function () {
  if (window.top !== window) return;

  function post(data) {
    window.postMessage({ source: "guardian-ext", ...data }, location.origin);
  }

  function ask(action, extra) {
    return chrome.runtime
      .sendMessage({ type: "WEB_BRIDGE", action, ...extra })
      .catch(() => null);
  }

  ask("PING").then((res) => {
    if (res?.trusted) post({ type: "READY", status: res });
  });

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== "guardian-web") return;

    if (msg.type === "PING") {
      const res = await ask("PING");
      if (res?.trusted) post({ type: "PONG", requestId: msg.requestId, status: res });
      return;
    }

    if (msg.type === "ENROLL") {
      const res = await ask("ENROLL", { code: msg.code, token: msg.token });
      if (res?.trusted) post({ type: "ENROLL_RESULT", requestId: msg.requestId, result: res });
    }
  });
})();
