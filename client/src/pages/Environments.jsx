import { useState } from 'react';
import { api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { useCollection } from '../hooks/useCollection.js';

const EMPTY = { name: '', url: '', kind: 'service' };

export default function Environments() {
  const { items, error, create, remove } = useCollection('environments');
  const [form, setForm] = useState(EMPTY);
  const [checks, setChecks] = useState({});

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim() || !form.url.trim()) return;
    await create(form);
    setForm(EMPTY);
  };

  const ping = async (environment) => {
    setChecks((current) => ({ ...current, [environment.id]: { pending: true } }));
    try {
      const result = await api.post('/tools/http', { url: environment.url, method: 'GET' });
      setChecks((current) => ({
        ...current,
        [environment.id]: { status: result.status, durationMs: result.durationMs }
      }));
    } catch (err) {
      setChecks((current) => ({ ...current, [environment.id]: { error: err.message } }));
    }
  };

  const pingAll = () => items.forEach(ping);

  const renderCheck = (id) => {
    const check = checks[id];
    if (!check) return <span className="muted right">not checked</span>;
    if (check.pending) return <span className="muted right">checking…</span>;
    if (check.error) return <span className="right status down">{check.error}</span>;
    return (
      <span className={`right status ${check.status < 400 ? 'up' : 'down'}`}>
        {check.status} · {check.durationMs}ms
      </span>
    );
  };

  return (
    <Page
      title="Environments"
      subtitle="Health-check the services you depend on."
      actions={
        <button type="button" onClick={pingAll} disabled={items.length === 0}>
          Check all
        </button>
      }
    >
      <ErrorBanner message={error} />
      <Card title="Register a service">
        <form className="form-grid" onSubmit={submit}>
          <input
            placeholder="Name (staging api)"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <input
            placeholder="https://health-endpoint"
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
          />
          <input placeholder="Kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} />
          <button type="submit">Add</button>
        </form>
      </Card>

      <Card>
        {items.length === 0 ? (
          <EmptyState>No services registered.</EmptyState>
        ) : (
          <ul className="list">
            {items.map((environment) => (
              <li key={environment.id}>
                <strong>{environment.name}</strong>
                <span className="tag">{environment.kind}</span>
                <span className="muted">{environment.url}</span>
                {renderCheck(environment.id)}
                <button className="ghost" type="button" onClick={() => ping(environment)}>
                  check
                </button>
                <button className="ghost" type="button" onClick={() => remove(environment.id)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
