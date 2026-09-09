import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(suite, 'build', 'web-mobile');
const source = join(suite, 'assets', 'scripts', 'game', 'AutonomousBridge.js');
const runtime = join(build, 'autonomous-bridge.js');
const index = join(build, 'index.html');
const mainAssets = join(build, 'assets', 'main');
const bundleName = readdirSync(mainAssets).find(name => /^index\.[^.]+\.js$/.test(name));
if (!bundleName) throw new Error('Cocos main bundle was not found; build web-mobile first.');
const bundle = join(mainAssets, bundleName);

copyFileSync(source, runtime);
let html = readFileSync(index, 'utf8');
const tag = '<script type="module" src="autonomous-bridge.js"></script>';
if (!html.includes(tag)) html = html.replace('</body>', `${tag}\n</body>`);
writeFileSync(index, html);

// Normal native play shows a delayed correct-move hint in Truck Escape. Autonomous
// mode must retain the native menus without disclosing that strategy signal.
let js = readFileSync(bundle, 'utf8');
const original = 'r.setAutoHintEnabled(!t),r.setDirectLaunchMode(n)';
const replacement = 'r.setAutoHintEnabled(!t&&!["1","true","yes"].includes((new URLSearchParams(globalThis.location&&globalThis.location.search||"").get("autonomous")||"").trim().toLowerCase())),r.setDirectLaunchMode(n)';
if (!js.includes(replacement)) {
  if (!js.includes(original)) throw new Error('Truck auto-hint build signature changed; rebuild with Cocos Creator before patching.');
  js = js.replace(original, replacement);
  writeFileSync(bundle, js);
}
console.log(`Updated ${runtime}, ${index}, and autonomous Truck hint policy.`);
