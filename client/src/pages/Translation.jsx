import { useEffect, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

function severityClass(severity) {
  if (severity === 'high') return 'pill high';
  if (severity === 'medium') return 'pill medium';
  return severity === 'info' ? 'pill' : 'pill low';
}

export default function Translation() {
  const [config, setConfig] = useState({ llmAvailable: false });
  const [useLlm, setUseLlm] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState('issues');
  const sourceRef = useRef(null);
  const targetRef = useRef(null);

  const loadHistory = () => api.get('/translation/audits').then(setHistory).catch(() => {});

  useEffect(() => {
    api.get('/translation/config').then(setConfig).catch(() => {});
    loadHistory();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    const source = sourceRef.current?.files?.[0];
    const target = targetRef.current?.files?.[0];
    if (!source || !target) {
      setError('Pick both the Arabic original and the English translation.');
      return;
    }
    const form = new FormData();
    form.append('source', source);
    form.append('target', target);

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${BASE}/translation/audit?llm=${useLlm && config.llmAvailable}`, {
        method: 'POST',
        body: form
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `Audit failed (${response.status})`);
      setResult(data);
      loadHistory();
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  const segments = result
    ? result.segments.filter((segment) => (filter === 'issues' ? segment.issues.length > 0 : true))
    : [];

  return (
    <Page title="Translation Audit" subtitle="Upload the Arabic original and its English translation to review the work.">
      <ErrorBanner message={error} />

      <Card title="Documents">
        <form className="form-stack" onSubmit={submit}>
          <div className="row">
            <label className="file-field">
              <span className="muted">Arabic original (.docx)</span>
              <input type="file" accept=".docx" ref={sourceRef} />
            </label>
            <label className="file-field">
              <span className="muted">English translation (.docx)</span>
              <input type="file" accept=".docx" ref={targetRef} />
            </label>
          </div>
          <div className="row">
            <label className="row">
              <input
                type="checkbox"
                checked={useLlm && config.llmAvailable}
                disabled={!config.llmAvailable}
                onChange={(event) => setUseLlm(event.target.checked)}
              />
              <span className={config.llmAvailable ? '' : 'muted'}>
                {config.llmAvailable
                  ? `Add semantic review (${config.model})`
                  : 'Semantic review unavailable — no model reachable'}
              </span>
            </label>
            <button type="submit" disabled={pending}>
              {pending ? 'auditing…' : 'Audit translation'}
            </button>
          </div>
        </form>
      </Card>

      {result && (
        <>
          <div className="grid stats-grid">
            <Card title="Score">
              <p className="metric">{result.summary.score}</p>
              <p className="muted">{result.summary.verdict}</p>
            </Card>
            <Card title="Issues">
              <p className="metric">{result.summary.issues}</p>
              <p className="muted">
                {result.summary.bySeverity.high} high · {result.summary.bySeverity.medium} medium ·{' '}
                {result.summary.bySeverity.low} low
              </p>
            </Card>
            <Card title="Segments">
              <p className="metric">{result.summary.segments}</p>
              <p className="muted">
                {result.summary.sourceParagraphs} AR / {result.summary.targetParagraphs} EN paragraphs ·{' '}
                {result.summary.alignment === 'paragraph-parallel'
                  ? '1:1 paragraph match'
                  : `${result.summary.alignment === 'clause-level' ? 'clause-level' : 'heuristic'} alignment · ${
                      result.summary.uncertainSegments
                    } pair(s) need a manual look`}
              </p>
            </Card>
            <Card title="Words">
              <p className="metric">{result.summary.targetWords}</p>
              <p className="muted">
                vs {result.summary.sourceWords} Arabic · ratio {result.summary.expansionRatio}
              </p>
            </Card>
          </div>

          {result.llm?.error && <ErrorBanner message={`Semantic review skipped: ${result.llm.error}`} />}

          <Card title="Issues by type">
            {result.summary.issues === 0 ? (
              <EmptyState>No problems detected by the configured checks.</EmptyState>
            ) : (
              <div className="tags">
                {Object.entries(result.summary.byType)
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, count]) => (
                    <span className="tag" key={type}>
                      {type.replace(/_/g, ' ')} · {count}
                    </span>
                  ))}
              </div>
            )}
          </Card>

          <div className="tabs">
            {['issues', 'all'].map((value) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'tab active' : 'tab'}
                onClick={() => setFilter(value)}
              >
                {value === 'issues' ? 'flagged segments' : 'all segments'}
              </button>
            ))}
          </div>

          {segments.length === 0 ? (
            <Card>
              <EmptyState>Nothing flagged.</EmptyState>
            </Card>
          ) : (
            segments.map((segment) => (
              <Card key={segment.index} title={`Segment ${segment.index}`}>
                <div className="segment">
                  <p className="arabic" dir="rtl" lang="ar">
                    {segment.source || <span className="muted">— no Arabic source —</span>}
                  </p>
                  <p lang="en">{segment.target || <span className="muted">— no English translation —</span>}</p>
                </div>
                <ul className="list">
                  {[...segment.issues]
                    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
                    .map((issue, index) => (
                      <li key={`${issue.type}-${index}`}>
                        <span className={severityClass(issue.severity)}>{issue.severity}</span>
                        <span className="tag">{issue.type.replace(/_/g, ' ')}</span>
                        <span>{issue.message}</span>
                        {issue.detail && <span className="muted right">{issue.detail}</span>}
                      </li>
                    ))}
                </ul>
              </Card>
            ))
          )}
        </>
      )}

      <Card title="Recent audits">
        {history.length === 0 ? (
          <EmptyState>No audits run yet.</EmptyState>
        ) : (
          <ul className="list">
            {history.slice(0, 10).map((audit) => (
              <li key={audit.id}>
                <span>{audit.files?.source}</span>
                <span className="muted">→ {audit.files?.target}</span>
                <span className="tag">score {audit.summary?.score}</span>
                <span className="muted right">{new Date(audit.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
