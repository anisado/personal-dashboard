import { useState } from 'react';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { useCollection } from '../hooks/useCollection.js';

const EMPTY = { title: '', body: '', tags: '' };

export default function Notes() {
  const { items, error, create, remove } = useCollection('notes');
  const [form, setForm] = useState(EMPTY);
  const [query, setQuery] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (!form.title.trim()) return;
    await create(form);
    setForm(EMPTY);
  };

  const term = query.trim().toLowerCase();
  const visible = items.filter((note) =>
    !term ||
    note.title.toLowerCase().includes(term) ||
    note.body.toLowerCase().includes(term) ||
    (note.tags || []).some((tag) => tag.toLowerCase().includes(term))
  );

  return (
    <Page title="Notes" subtitle="Scratchpad for decisions, commands and meeting notes.">
      <ErrorBanner message={error} />
      <Card title="New note">
        <form className="form-stack" onSubmit={submit}>
          <input
            placeholder="Title"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <textarea
            rows={5}
            placeholder="Write it down..."
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
          />
          <div className="row">
            <input
              placeholder="tags, comma, separated"
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
            />
            <button type="submit">Save note</button>
          </div>
        </form>
      </Card>

      <input className="search" placeholder="Search notes" value={query} onChange={(event) => setQuery(event.target.value)} />

      {visible.length === 0 ? (
        <Card>
          <EmptyState>No notes match.</EmptyState>
        </Card>
      ) : (
        <div className="grid two-col">
          {visible.map((note) => (
            <Card key={note.id} title={note.title}>
              <pre className="note-body">{note.body}</pre>
              <div className="row space-between">
                <div className="tags">
                  {(note.tags || []).map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <button className="ghost" type="button" onClick={() => remove(note.id)}>
                  delete
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
