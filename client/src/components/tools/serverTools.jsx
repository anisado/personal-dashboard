import { useState } from 'react';
import { api } from '../../api.js';
import { Card } from '../Page.jsx';

export function UuidGenerator() {
  const [uuids, setUuids] = useState([]);
  const [count, setCount] = useState(5);
  const [error, setError] = useState(null);

  const generate = async () => {
    try {
      const data = await api.get(`/tools/uuid?count=${count}`);
      setUuids(data.uuids);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Card title="UUID generator">
      <div className="row">
        <input type="number" min={1} max={50} value={count} onChange={(event) => setCount(Number(event.target.value))} />
        <button type="button" onClick={generate}>
          Generate
        </button>
      </div>
      {error && <p className="status down">{error}</p>}
      <pre className="code">{uuids.join('\n')}</pre>
    </Card>
  );
}

export function HashGenerator() {
  const [text, setText] = useState('');
  const [digests, setDigests] = useState(null);
  const [error, setError] = useState(null);

  const hash = async () => {
    try {
      const data = await api.post('/tools/hash', { text });
      setDigests(data.digests);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Card title="Hash generator">
      <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="text to hash" />
      <button type="button" onClick={hash}>
        Hash
      </button>
      {error && <p className="status down">{error}</p>}
      {digests && (
        <ul className="list">
          {Object.entries(digests).map(([algorithm, digest]) => (
            <li key={algorithm}>
              <span>{algorithm}</span>
              <span className="right mono break">{digest}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function JwtDecoder() {
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const decode = async () => {
    try {
      setResult(await api.post('/tools/jwt/decode', { token }));
      setError(null);
    } catch (err) {
      setResult(null);
      setError(err.message);
    }
  };

  return (
    <Card title="JWT decoder">
      <textarea rows={3} className="mono" value={token} onChange={(event) => setToken(event.target.value)} placeholder="paste a JWT" />
      <button type="button" onClick={decode}>
        Decode
      </button>
      {error && <p className="status down">{error}</p>}
      {result && (
        <>
          <p className={result.expired ? 'status down' : 'status up'}>
            {result.expiresAt ? `expires ${result.expiresAt}` : 'no expiry claim'}
          </p>
          <pre className="code">{JSON.stringify({ header: result.header, payload: result.payload }, null, 2)}</pre>
        </>
      )}
    </Card>
  );
}

export function CronPreview() {
  const [expression, setExpression] = useState('*/15 9-17 * * 1-5');
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);

  const preview = async () => {
    try {
      const data = await api.post('/tools/cron', { expression });
      setRuns(data.runs);
      setError(null);
    } catch (err) {
      setRuns([]);
      setError(err.message);
    }
  };

  return (
    <Card title="Cron preview">
      <div className="row">
        <input className="mono" value={expression} onChange={(event) => setExpression(event.target.value)} />
        <button type="button" onClick={preview}>
          Next runs
        </button>
      </div>
      {error && <p className="status down">{error}</p>}
      <ul className="list">
        {runs.map((run) => (
          <li key={run}>
            <span className="mono">{run}</span>
            <span className="muted right">{new Date(run).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function HttpClient() {
  const [url, setUrl] = useState('https://api.github.com/zen');
  const [method, setMethod] = useState('GET');
  const [body, setBody] = useState('');
  const [headers, setHeaders] = useState('');
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const send = async () => {
    setPending(true);
    try {
      const parsedHeaders = headers.trim()
        ? Object.fromEntries(
            headers
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                const [key, ...rest] = line.split(':');
                return [key.trim(), rest.join(':').trim()];
              })
          )
        : {};
      setResponse(await api.post('/tools/http', { url, method, headers: parsedHeaders, body: body || undefined }));
      setError(null);
    } catch (err) {
      setResponse(null);
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title="HTTP request runner" className="wide">
      <div className="row">
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <input className="mono grow" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button type="button" onClick={send} disabled={pending}>
          {pending ? 'sending…' : 'Send'}
        </button>
      </div>
      <textarea
        rows={2}
        className="mono"
        placeholder={'Header-Name: value (one per line)'}
        value={headers}
        onChange={(event) => setHeaders(event.target.value)}
      />
      <textarea rows={3} className="mono" placeholder="request body" value={body} onChange={(event) => setBody(event.target.value)} />
      {error && <p className="status down">{error}</p>}
      {response && (
        <>
          <p className={response.status < 400 ? 'status up' : 'status down'}>
            {response.status} {response.statusText} · {response.durationMs}ms
          </p>
          <pre className="code">{response.body}</pre>
        </>
      )}
    </Card>
  );
}
