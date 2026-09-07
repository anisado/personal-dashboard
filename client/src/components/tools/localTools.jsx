import { useMemo, useState } from 'react';
import { Card } from '../Page.jsx';

export function JsonFormatter() {
  const [input, setInput] = useState('{"hello":"world","list":[1,2,3]}');
  const [indent, setIndent] = useState(2);

  const result = useMemo(() => {
    if (!input.trim()) return { output: '' };
    try {
      return { output: JSON.stringify(JSON.parse(input), null, indent) };
    } catch (err) {
      return { error: err.message };
    }
  }, [input, indent]);

  return (
    <Card title="JSON formatter & validator">
      <textarea rows={6} className="mono" value={input} onChange={(event) => setInput(event.target.value)} />
      <div className="row">
        <label className="muted">indent</label>
        <select value={indent} onChange={(event) => setIndent(Number(event.target.value))}>
          <option value={2}>2</option>
          <option value={4}>4</option>
          <option value={0}>minified</option>
        </select>
      </div>
      {result.error ? <p className="status down">{result.error}</p> : <pre className="code">{result.output}</pre>}
    </Card>
  );
}

export function Base64Tool() {
  const [text, setText] = useState('hello developer');
  const [mode, setMode] = useState('encode');

  const output = useMemo(() => {
    try {
      if (mode === 'encode') return btoa(unescape(encodeURIComponent(text)));
      return decodeURIComponent(escape(atob(text.trim())));
    } catch {
      return 'Invalid input for this mode';
    }
  }, [text, mode]);

  return (
    <Card title="Base64 / URL encoder">
      <div className="tabs">
        {['encode', 'decode'].map((value) => (
          <button key={value} type="button" className={mode === value ? 'tab active' : 'tab'} onClick={() => setMode(value)}>
            {value}
          </button>
        ))}
      </div>
      <textarea rows={4} className="mono" value={text} onChange={(event) => setText(event.target.value)} />
      <pre className="code">{output}</pre>
      <p className="muted">URL encoded: {encodeURIComponent(text)}</p>
    </Card>
  );
}

export function RegexTester() {
  const [pattern, setPattern] = useState('(\\w+)@(\\w+)\\.com');
  const [flags, setFlags] = useState('g');
  const [sample, setSample] = useState('ping dev@example.com and ops@acme.com');

  const result = useMemo(() => {
    try {
      const regex = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
      return { matches: [...sample.matchAll(regex)].map((match) => ({ match: match[0], groups: match.slice(1), index: match.index })) };
    } catch (err) {
      return { error: err.message };
    }
  }, [pattern, flags, sample]);

  return (
    <Card title="Regex tester">
      <div className="row">
        <input className="mono" value={pattern} onChange={(event) => setPattern(event.target.value)} />
        <input className="mono flags" value={flags} onChange={(event) => setFlags(event.target.value)} />
      </div>
      <textarea rows={4} value={sample} onChange={(event) => setSample(event.target.value)} />
      {result.error ? (
        <p className="status down">{result.error}</p>
      ) : (
        <ul className="list">
          {result.matches.length === 0 && <li className="muted">No matches</li>}
          {result.matches.map((match, index) => (
            <li key={`${match.index}-${index}`}>
              <code>{match.match}</code>
              <span className="muted">at {match.index}</span>
              {match.groups.length > 0 && <span className="muted right">groups: {match.groups.join(', ')}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TimestampTool() {
  const [value, setValue] = useState(String(Math.floor(Date.now() / 1000)));

  const parsed = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    const date = Number.isFinite(numeric)
      ? new Date(trimmed.length > 10 ? numeric : numeric * 1000)
      : new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }, [value]);

  return (
    <Card title="Timestamp converter">
      <div className="row">
        <input className="mono" value={value} onChange={(event) => setValue(event.target.value)} />
        <button type="button" onClick={() => setValue(String(Math.floor(Date.now() / 1000)))}>
          now
        </button>
      </div>
      {parsed ? (
        <ul className="list">
          <li>
            <span>ISO 8601</span>
            <span className="right mono">{parsed.toISOString()}</span>
          </li>
          <li>
            <span>Local</span>
            <span className="right mono">{parsed.toLocaleString()}</span>
          </li>
          <li>
            <span>Unix seconds</span>
            <span className="right mono">{Math.floor(parsed.getTime() / 1000)}</span>
          </li>
        </ul>
      ) : (
        <p className="status down">Unrecognized date or timestamp</p>
      )}
    </Card>
  );
}
