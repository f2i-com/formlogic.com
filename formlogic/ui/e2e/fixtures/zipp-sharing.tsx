import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostedAppFrame } from '../../src/components/studio/HostedAppFrame';
import { calculateValueForFlow } from '../../src/lib/formlogic/engine';

// Exercise the real parent bridge, expression worker and production Softn shell.
// All data and backend responses belong to this isolated local test fixture.
const client = {
  'manifest.json': JSON.stringify({ main: 'ui/main.ui', files: { logic: ['logic/main.logic'] } }),
  'ui/main.ui': `<logic src="../logic/main.logic" />
  <div>
    <h1>Shared engine app</h1>
    <p data-testid="count">{count}</p>
    <button @click={increment()}>Add one</button>
    <button @click={checkBackend()}>Check backend</button>
    <p data-testid="backend">{backendResult}</p>
  </div>`,
  'logic/main.logic': `let count = 0;
let backendResult = "Waiting";
function increment() { count = count + 1; }
function checkBackend() {
  softn.backend.call("echo", { message: "Connected" }, function(value) {
    backendResult = value.result.message;
  });
}`,
};

// The same app with its logic written in Python. One client FILE NAME apart from the bundle
// above: that name is the whole declaration, the shell derives the language from it, and the
// FormLogic server derives the same list from the same names to decide the engine.
const pythonClient = {
  'manifest.json': JSON.stringify({ main: 'ui/main.ui', files: { logic: ['logic/main.py'] } }),
  'ui/main.ui': `<logic src="../logic/main.py" />
  <div>
    <h1>Shared engine app</h1>
    <p data-testid="count">{count}</p>
    <button @click={increment()}>Add one</button>
  </div>`,
  'logic/main.py': `count = 0

def increment():
    global count
    count = count + 1
`,
};

// The engine the server would have decided, as a query parameter, so one fixture can be driven
// onto either runtime document. `?engine=host-js` is what a verified owner's app gets: the frame
// mounts host.html and no engine bytes are fetched at all. `?logic=python` swaps the bundle for
// the Python one, which only the web-python engine can run.
const parameters = new URLSearchParams(window.location.search);
const decided = parameters.get('engine');
const engine = decided ? { id: decided, revision: 'fixture' } : undefined;
const initialClient = parameters.get('logic') === 'python' ? pythonClient : client;

function Fixture() {
  const [apps, setApps] = useState<number[]>([]);
  const [answer, setAnswer] = useState('Not evaluated');
  const [currentClient, setCurrentClient] = useState<Record<string, string>>(initialClient);
  async function evaluate() {
    setAnswer('Evaluating');
    try {
      setAnswer(String(await calculateValueForFlow('price * quantity', { price: 7, quantity: 6 })));
    } catch (error) {
      setAnswer(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return <main>
    <button onClick={() => void evaluate()}>Evaluate expression</button>
    <output data-testid="answer">{answer}</output>
    <button onClick={() => setApps(current => [...current, current.length])}>Open app</button>
    <button onClick={() => { setApps([0]); void evaluate(); }}>Open and evaluate together</button>
    <button onClick={() => setApps([])}>Close apps</button>
    <button onClick={() => setCurrentClient({ ...client, 'logic/main.logic': client['logic/main.logic'].replace('let count = 0;', 'let count = 10;') })}>Replace app source</button>
    {apps.map(id => <section key={id} data-testid={`app-${id}`}>
      <HostedAppFrame slug={`sharing-test-${id}`} version={1} client={currentClient} engine={engine} />
    </section>)}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
