// A 200 HTML response is not enough. vinext's production static-file cache currently
// builds Windows keys with backslashes, so /fleet can render while every /assets/* URL
// is a 404 and the browser gets an unstyled, unhydrated document. Check the resources
// named by the actual response so a local-server rollout cannot declare that state up.
const base = new URL(process.argv[2] || 'http://127.0.0.1:3000/');
const page = new URL('/fleet', base);
const htmlResponse = await fetch(page);
if (!htmlResponse.ok) throw new Error(`${page} returned ${htmlResponse.status}`);
const html = await htmlResponse.text();

const references = [...html.matchAll(/(?:href|src)=["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/gi)]
  .map(match => match[1])
  .filter(value => !value.startsWith('data:'));
const assets = [...new Set(references.map(value => new URL(value, page)))];
if (!assets.length) throw new Error(`${page} named no CSS or JavaScript resources`);

const failures = [];
for (const asset of assets) {
  const response = await fetch(asset);
  if (!response.ok) failures.push(`${asset.pathname}: ${response.status}`);
  await response.body?.cancel();
}
if (failures.length) throw new Error(`local page has missing resources — ${failures.join(', ')}`);

console.log(`local strategy game is styled and loadable — ${assets.length} page resource(s) returned successfully`);
