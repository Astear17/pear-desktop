import { expect, test } from '@playwright/test';

import {
  normalizeThemeState,
  paletteToCss,
  parseManifest,
  resolvePalette,
} from '../src/themes/types';

test('parses a manifest with a palette and a single css file', () => {
  expect(
    parseManifest(
      JSON.stringify({
        name: 'My Theme',
        palette: { accent: '#22c55e', font: 'monospace' },
        css: 'style.css',
      }),
    ),
  ).toEqual({
    name: 'My Theme',
    palette: { accent: '#22c55e', font: 'monospace' },
    css: 'style.css',
  });
});

test('palette values are arbitrary CSS values, not just colours', () => {
  const manifest = parseManifest(
    JSON.stringify({ palette: { font: 'monospace', radius: '8px' } }),
  );
  expect(manifest?.palette).toEqual({ font: 'monospace', radius: '8px' });
});

test('rejects malformed or wrongly typed manifests', () => {
  for (const raw of [
    'not json',
    '[]',
    '"string"',
    JSON.stringify({ palette: { accent: 123 } }),
    JSON.stringify({ css: [1, 2] }),
    JSON.stringify({ palette: ['#fff'] }),
  ]) {
    expect(parseManifest(raw), raw).toBeNull();
  }
});

test('a manifest may omit palette and css', () => {
  expect(parseManifest('{}')).toEqual({});
});

test('overrides win over the theme palette and keep the other keys', () => {
  const resolved = resolvePalette(
    { accent: '#22c55e', background: '#0a0a0a' },
    { accent: '#ff00ff' },
  );
  expect(resolved).toEqual({ accent: '#ff00ff', background: '#0a0a0a' });
});

test('palette is emitted as custom properties, values verbatim', () => {
  expect(paletteToCss({ accent: '#22c55e', font: 'monospace' })).toBe(
    ':root {\n  --pear-theme-accent: #22c55e;\n  --pear-theme-font: monospace;\n}',
  );
});

test('an empty theme payload normalizes instead of crashing', () => {
  // A config predating these keys yields an empty payload; reading a palette
  // override off it used to throw and abort renderer init.
  expect(normalizeThemeState({})).toEqual({
    themes: [],
    selected: '',
    overrides: {},
  });
  expect(normalizeThemeState({ themes: [], selected: 'basic' })).toEqual({
    themes: [],
    selected: 'basic',
    overrides: {},
  });
});

test('defaults survive a payload with explicit undefined values', () => {
  expect(
    normalizeThemeState({ themes: undefined, selected: undefined }),
  ).toEqual({ themes: [], selected: '', overrides: {} });
});
