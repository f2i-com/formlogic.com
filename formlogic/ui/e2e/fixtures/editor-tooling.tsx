import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as monaco from 'monaco-editor';
import MonacoEditorImpl from '../../src/components/ui/MonacoEditorImpl';

let editor: monaco.editor.IStandaloneCodeEditor | undefined;

monaco.languages.registerHoverProvider('typescript', {
  provideHover: () => ({ contents: [{ value: '**Booking help**\n\nEdit the customer name before saving.' }] }),
});

function EditorToolingCheck() {
  const [value, setValue] = useState('const customer = "Lance";');
  const [diagnostics, setDiagnostics] = useState('Not checked');
  const checkWorker = async () => {
    const model = editor?.getModel();
    if (!model) throw new Error('Editor model is not ready');
    const workerFor = await monaco.typescript.getTypeScriptWorker();
    const worker = await workerFor(model.uri);
    const result = await worker.getSyntacticDiagnostics(model.uri.toString());
    setDiagnostics(`TypeScript worker: ${result.length} syntax errors`);
  };

  return <main>
    <h1>Editor tooling check</h1>
    <button onClick={() => void checkWorker()}>Check TypeScript worker</button>
    <button onClick={() => editor?.focus()}>Focus editor</button>
    <button onClick={() => {
      editor?.setPosition({ lineNumber: 1, column: 8 });
      editor?.focus();
      editor?.trigger('tooling-check', 'editor.action.showHover', {});
    }}>Show booking help</button>
    <p role="status" aria-label="Worker result">{diagnostics}</p>
    <MonacoEditorImpl value={value} onChange={setValue} height="350px" path="file:///tooling-check.ts" onMount={(instance) => { editor = instance; }} />
    <output aria-label="Editor value">{value}</output>
  </main>;
}

createRoot(document.getElementById('root')!).render(<EditorToolingCheck />);
