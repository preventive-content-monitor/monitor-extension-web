const KEY = "eventQueue";

export async function enqueueEvent(event) {
  const { eventQueue } = await chrome.storage.local.get([KEY]);
  const queue = Array.isArray(eventQueue) ? eventQueue : [];
  queue.push(event);
  await chrome.storage.local.set({ [KEY]: queue });
}
    
export async function drainQueue(max = 100) {
  const { eventQueue } = await chrome.storage.local.get([KEY]);
  const queue = Array.isArray(eventQueue) ? eventQueue : [];
  const batch = queue.slice(0, max);
  const remaining = queue.slice(max);
  await chrome.storage.local.set({ [KEY]: remaining });
  return batch;
}
