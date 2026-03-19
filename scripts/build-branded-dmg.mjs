import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const agentDir = path.join(rootDir, 'local-agent-mac');
const distDir = path.join(rootDir, 'dist');

const brandName = process.argv[2];
const outputName = process.argv[3];

if (!brandName || !outputName) {
  console.error('Usage: node scripts/build-branded-dmg.mjs <brandName> <outputName>');
  process.exit(1);
}

const files = {
  packageJson: path.join(agentDir, 'package.json'),
  mainMjs: path.join(agentDir, 'desktop', 'main.mjs'),
  rendererIndex: path.join(agentDir, 'desktop', 'renderer', 'index.html'),
  rendererApp: path.join(agentDir, 'desktop', 'renderer', 'app.js'),
};

const originals = new Map();

async function remember(file) {
  if (!originals.has(file)) {
    originals.set(file, await fs.readFile(file, 'utf8'));
  }
}

async function restoreAll() {
  for (const [file, content] of originals.entries()) {
    await fs.writeFile(file, content, 'utf8');
  }
}

async function patchBrand() {
  await remember(files.packageJson);
  await remember(files.mainMjs);
  await remember(files.rendererIndex);
  await remember(files.rendererApp);

  const pkg = JSON.parse(await fs.readFile(files.packageJson, 'utf8'));
  pkg.build = pkg.build || {};
  pkg.build.productName = brandName;
  await fs.writeFile(files.packageJson, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const mainText = (await fs.readFile(files.mainMjs, 'utf8')).replace(/title: '.*?'/, `title: '${brandName}'`);
  await fs.writeFile(files.mainMjs, mainText, 'utf8');

  let indexText = await fs.readFile(files.rendererIndex, 'utf8');
  indexText = indexText.replace(/<title>.*?<\/title>/, `<title>${brandName}</title>`);
  indexText = indexText.replace(/<h1>.*?<\/h1>/, `<h1>${brandName}</h1>`);
  await fs.writeFile(files.rendererIndex, indexText, 'utf8');

  const appText = (await fs.readFile(files.rendererApp, 'utf8')).replace(/欢迎使用 .*?。请先完成首次配置。/, `欢迎使用 ${brandName}。请先完成首次配置。`);
  await fs.writeFile(files.rendererApp, appText, 'utf8');
}

function zsh(command) {
  execSync(command, {
    cwd: agentDir,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    shell: '/bin/zsh',
  });
}

async function main() {
  await fs.mkdir(distDir, { recursive: true });
  try {
    await patchBrand();
    zsh('npm install');
    zsh('npx electron-builder --mac dir --universal');
    const appPath = path.join(agentDir, 'release', 'mac-universal', `${brandName}.app`);
    const target = path.join(distDir, outputName);
    await fs.rm(target, { force: true });
    zsh(`hdiutil create -volname ${JSON.stringify(brandName)} -srcfolder ${JSON.stringify(appPath)} -ov -format UDZO ${JSON.stringify(target)}`);
    console.log(`DMG generated: ${target}`);
  } finally {
    await restoreAll();
  }
}

main().catch(async (err) => {
  try {
    await restoreAll();
  } catch {}
  console.error(err);
  process.exit(1);
});
