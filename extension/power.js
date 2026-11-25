const key = 'on';
let on = true;

export const powerReady = chrome.storage.local.get(key).then(data => { on = data[key] !== false; });
export const isOn = () => on;

export function offError() {
  return Object.assign(new Error('Pi Browser is turned off in the browser. Click its toolbar icon to turn it on.'), { code: 'off' });
}

export function checkPower() {
  if (!on) throw offError();
}

export async function flipPower() {
  const next = !on;
  await chrome.storage.local.set({ [key]: next });
  on = next;
  return on;
}
