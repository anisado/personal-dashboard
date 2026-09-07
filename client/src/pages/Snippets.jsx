import { useState } from 'react';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { useCollection } from '../hooks/useCollection.js';

const EMPTY = { title: '', language: 'bash', code: '', tags: '' };
const LANGUAGES = ['bash', 'javascript', 'typescript', 'python', 'sql', 'yaml', 'json', 'go', 'rust', 'text'];

export default function Snippets() {
  const { items, error, create, remove } = useCollection('snippets');
  const [form, setForm] = useState(EMPTY);
  const [copied, setCopied] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.code.trim()) return;
    await create(form);
    setForm(EMPTY);
  };

  const copy = async (snippet) => {
    await navigator.clipboard?.writeText(snippet.code);
    setCopied(snippet.id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Page title="Snippets" subtitle="Commands and code you keep re-typing.">
      <ErrorBanner message={error} />
      <Card title="New snippet">
        <form className="form-stack" onSubmit={submit}>
          <div className="row">
            <input
              placeholder="Title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
            <select value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </div>
          <textarea
            rows={6}
            className="mono"
            placeholder="paste code here"
            value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value })}
          />
          <div className="row">
            <input
              placeholder="tags, comma, separated"
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
            />
            <button type="submit">Save snippet</button>
          </div>
        </form>
      </Card>

      {items.length === 0 ? (
        <Card>
          <EmptyState>No snippets saved yet.</EmptyState>
        </Card>
      ) : (
        items.map((snippet) => (
          <Card key={snippet.id} title={`${snippet.title} · ${snippet.language}`}>
            <pre className="code">{snippet.code}</pre>
            <div className="row space-between">
              <div className="tags">
                {(snippet.tags || []).map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
              <div className="row">
                <button className="ghost" type="button" onClick={() => copy(snippet)}>
                  {copied === snippet.id ? 'copied!' : 'copy'}
                </button>
                <button className="ghost" type="button" onClick={() => remove(snippet.id)}>
                  delete
                </button>
              </div>
            </div>
          </Card>
        ))
      )}
    </Page>
  );
}
