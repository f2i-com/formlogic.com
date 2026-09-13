import type * as Monaco from 'monaco-editor';

/** Softn markup with JavaScript logic/bindings and CSS style blocks. */
export function registerSoftnLanguage(monaco: typeof Monaco) {
  if (monaco.languages.getLanguages().some(language => language.id === 'softn')) return;
  monaco.languages.register({ id: 'softn', extensions: ['.ui'] });
  monaco.languages.setLanguageConfiguration('softn', {
    comments: { blockComment: ['<!--', '-->'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '"', close: '"' }],
  });
  monaco.languages.setMonarchTokensProvider('softn', {
    tokenPostfix: '.html',
    tokenizer: {
      root: [
        [/<!--/, 'comment', '@comment'],
        [/(<)(logic)(\s*)(>)/, ['delimiter', 'tag', '', { token: 'delimiter', next: '@logic', nextEmbedded: 'javascript' }]],
        [/(<)(style)(\s*)(>)/, ['delimiter', 'tag', '', { token: 'delimiter', next: '@style', nextEmbedded: 'css' }]],
        [/(<\/?)([\w.-]+)/, ['delimiter', { token: 'tag', next: '@tag' }]],
        [/\{[#:/]?(?:if|else|each|await|then|catch)\b/, 'keyword'],
        [/\{/, { token: 'delimiter.bracket', next: '@binding', nextEmbedded: 'javascript' }],
        [/[^<{]+/, ''],
      ],
      tag: [
        [/\/?>/, 'delimiter', '@pop'],
        [/"[^"]*"|'[^']*'/, 'string'],
        [/\{/, { token: 'delimiter.bracket', next: '@binding', nextEmbedded: 'javascript' }],
        [/[\w:.-]+/, 'attribute.name'],
        [/=/, 'delimiter'],
        [/\s+/, ''],
      ],
      binding: [
        [/\}/, { token: 'delimiter.bracket', next: '@pop', nextEmbedded: '@pop' }],
        [/./, ''],
      ],
      logic: [[/<\/logic\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
      style: [[/<\/style\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
      comment: [[/-->/, 'comment', '@pop'], [/[^-]+/, 'comment'], [/./, 'comment']],
    },
  });
}
