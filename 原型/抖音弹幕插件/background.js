// Relays for content.js: requests to the local server go out from the extension, not from the
// douyin.com page, so the browser does not treat them as a website reaching into the local network.
const SERVER = 'http://127.0.0.1:7860';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const request = msg.kind === 'config'
    ? fetch(`${SERVER}/api/douyin/config`).then(r => r.json())
    : fetch(`${SERVER}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'extension', events: msg.events }),
    }).then(r => r.json());
  request.then(reply, e => reply({ error: String(e) }));
  return true; // reply asynchronously
});
