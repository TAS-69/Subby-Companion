import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function exportHosting(source, destination) {
  source = resolve(source); destination = resolve(destination);
  const contains = (parent, child) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)); };
  if (contains(source, destination) || contains(destination, source)) throw new Error('Hosting output must be separate from the source checkout.');
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length) throw new Error('Hosting output must be empty.');
  function copy(relative, output = relative) {
    const input = join(source, relative), target = join(destination, output);
    const entry = lstatSync(input);
    if (entry.isSymbolicLink()) throw new Error('Hosting source cannot contain symbolic links.');
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(input)) copy(join(relative, name), join(output, name));
    } else {
      if (!entry.isFile()) throw new Error('Hosting source must contain regular files.');
      mkdirSync(dirname(target), { recursive: true });
      cpSync(input, target);
    }
  }
  for (const name of ['src', 'web', 'LICENSE', '.gitignore', 'package-lock.json']) copy(name);
  copy('hosting/index.js', 'index.js'); copy('hosting/.env.example', '.env.example');
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  manifest.scripts = { start: 'node index.js' };
  delete manifest.devDependencies;
  const lock = JSON.parse(readFileSync(join(destination, 'package-lock.json'), 'utf8'));
  delete lock.packages[''].devDependencies;
  for (const [name, entry] of Object.entries(lock.packages)) if (entry.dev) delete lock.packages[name];
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Provide a separate, empty output directory.');
  exportHosting(resolve(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2]);
  console.log('Hosting runtime exported.');
}
