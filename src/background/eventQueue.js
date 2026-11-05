const KEY = "eventQueue";
let operation = Promise.resolve();

function withQueue(operationFn) {
  const result = operation.then(operationFn);
  operation = result.catch((error) => console.error("[Guardian] Erro na fila de eventos:", error));
  return result;
}

export async function enqueueEvent(event) {
  return withQueue(async () => {
    const { eventQueue } = await chrome.storage.local.get([KEY]);
    const queue = Array.isArray(eventQueue) ? eventQueue : [];
    queue.push(event);
    await chrome.storage.local.set({ [KEY]: queue });
  });
}

export async function readQueue(max = 100) {
  return withQueue(async () => {
    const { eventQueue } = await chrome.storage.local.get([KEY]);
    return (Array.isArray(eventQueue) ? eventQueue : []).slice(0, max);
  });
}

export async function acknowledgeEvents(count) {
  return withQueue(async () => {
    const { eventQueue } = await chrome.storage.local.get([KEY]);
    const queue = Array.isArray(eventQueue) ? eventQueue : [];
    await chrome.storage.local.set({ [KEY]: queue.slice(count) });
  });
}
