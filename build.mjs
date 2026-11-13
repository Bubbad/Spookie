// Builds a single self-contained dist/spookie.html (three.js + game inlined).
import fs from 'node:fs';
const three = fs.readFileSync('lib/three.module.js', 'utf8');
const m = three.match(/\nexport \{([\s\S]*?)\};?\s*$/);
if (!m) throw new Error('export block not found');
const names = m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => { const [a, b] = s.split(/\s+as\s+/); return `${b || a}: ${a}`; });
const threeIife = `const THREE = (() => {\n${three.slice(0, m.index)}\nreturn { ${names.join(', ')} };\n})();`;
const game = fs.readFileSync('main.js', 'utf8').replace(/^import \* as THREE from 'three';\n/, '');
const html = fs.readFileSync('index.html', 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const body = html.match(/<body>([\s\S]*?)<script type="importmap"/)[1];
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/spookie.html', `<title>Spookie</title>
<style>${style}
  html, body { background: #0a0714; }
</style>
${body}<script type="module">
${threeIife}
${game}
</script>
`);
console.log('ok', fs.statSync('dist/spookie.html').size);
