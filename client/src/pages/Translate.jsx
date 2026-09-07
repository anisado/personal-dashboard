import { useEffect, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';

export default function Translate() {
  const [config, setConfig] = useState({ translationAvailable: false });
  const [glossary, setGlossary] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const sourceRef = useRef(null);

  const loadHistory = () => api.get('/translation/translations').then(setHistory).catch(() => {});

  useEffect(() => {
    api.get('/translation/config').then(setConfig).catch(() => {});
    loadHistory();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    const source = sourceRef.current?.files?.[0];
    if (!source) {
      setError('Pick the Arabic .docx to translate.');
      return;
    }
    const form = new FormData();
    form.append('source', source);
    if (glossary.trim()) {
      const terms = {};
      for (const line of glossary.split('\n')) {
        const [arabic, english] = line.split('=');
        if (arabic?.trim() && english?.trim()) terms[arabic.trim()] = english.trim();
      }
      form.append('glossary', JSON.stringify(terms));
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${BASE}/translation/translate`, { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `Translation failed (${response.status})`);
      setResult(data);
      loadHistory();
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  const copyAll = () => {
    if (!result) return;
    navigator.clipboard?.writeText(result.segments.map((segment) => segment.target).join('\n\n'));
  };

  return (
    <Page
      title="Translate"
      subtitle="Arabic legal documents translated to English paragraph by paragraph, ready to audit."
    >
      <ErrorBanner message={error} />

      <Card title="Arabic document">
        <form className="form-stack" onSubmit={submit}>
          <label className="file-field">
            <span className="muted">Arabic original (.docx)</span>
            <input type="file" accept=".docx" ref={sourceRef} />
          </label>
          <label className="file-field">
            <span className="muted">Glossary — one `arabic = english` pair per line (optional)</span>
            <textarea
              rows={3}
              value={glossary}
              onChange={(event) => setGlossary(event.target.value)}
              placeholder="الطرف الأول = the First Party"
            />
          </label>
          <div className="row">
            <span className={config.translationAvailable ? 'muted' : ''}>
              {config.translationAvailable
                ? `Engine: ${config.model}`
                : 'Translation unavailable — start the API with a model: ./scripts/local-ai.sh'}
            </span>
            <button type="submit" disabled={pending || !config.translationAvailable}>
              {pending ? 'translating…' : 'Translate document'}
            </button>
          </div>
        </form>
      </Card>

      {result && (
        <>
          <Card title={`${result.file} — ${result.segments.length} paragraphs`}>
            <div className="row">
              <a className="tag" href={`${BASE}/translation/translations/${result.id}/docx`}>
                download .docx
              </a>
              <button type="button" onClick={copyAll}>
                copy English
              </button>
              <span className="muted right">{result.model}</span>
            </div>
          </Card>

          {result.segments.map((segment) => (
            <Card key={segment.index} title={`Paragraph ${segment.index}`}>
              <div className="segment">
                <p className="arabic" dir="rtl" lang="ar">
                  {segment.source}
                </p>
                <p lang="en">{segment.target || <span className="muted">— not translated —</span>}</p>
              </div>
            </Card>
          ))}
        </>
      )}

      <Card title="Recent translations">
        {history.length === 0 ? (
          <EmptyState>No documents translated yet.</EmptyState>
        ) : (
          <ul className="list">
            {history.slice(0, 10).map((item) => (
              <li key={item.id}>
                <span>{item.file}</span>
                <span className="tag">{item.paragraphs} paragraphs</span>
                <a className="tag" href={`${BASE}/translation/translations/${item.id}/docx`}>
                  .docx
                </a>
                <span className="muted right">{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
