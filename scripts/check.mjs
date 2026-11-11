import { readdir, readFile } from 'node:fs/promises';
import { SourceTextModule } from 'node:vm';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) await check(new URL(`${entry.name}/`, directory));
    else if (/\.(m?js)$/.test(entry.name)) {
      const module = new SourceTextModule(await readFile(path, 'utf8'), { identifier: path.href });
      for (const specifier of module.dependencySpecifiers) {
        if (specifier.startsWith('.')) await readFile(new URL(specifier, path));
      }
    }
  }
}
await check(new URL('../src/', import.meta.url));
await check(new URL('../scripts/', import.meta.url));
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
if (/\b(?:src|href)="\//.test(html)) throw new Error('Use relative asset URLs for GitHub Pages.');
console.log('JavaScript syntax and GitHub Pages asset paths checked.');
