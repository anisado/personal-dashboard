import { useState } from 'react';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { useCollection } from '../hooks/useCollection.js';

const EMPTY = { title: '', url: '', category: 'docs' };

export default function Bookmarks() {
  const { items, error, create, remove } = useCollection('bookmarks');
  const [form, setForm] = useState(EMPTY);

  const submit = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.url.trim()) return;
    await create(form);
    setForm(EMPTY);
  };

  const categories = [...new Set(items.map((item) => item.category))].sort();

  return (
    <Page title="Bookmarks" subtitle="Docs, dashboards and tools you open every day.">
      <ErrorBanner message={error} />
      <Card title="New bookmark">
        <form className="form-grid" onSubmit={submit}>
          <input
            placeholder="Title"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <input
            placeholder="https://..."
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
          />
          <input
            placeholder="Category"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          />
          <button type="submit">Add</button>
        </form>
      </Card>

      {items.length === 0 ? (
        <Card>
          <EmptyState>No bookmarks yet.</EmptyState>
        </Card>
      ) : (
        categories.map((category) => (
          <Card key={category} title={category}>
            <ul className="list">
              {items
                .filter((item) => item.category === category)
                .map((item) => (
                  <li key={item.id}>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                    <span className="muted right">{item.url}</span>
                    <button className="ghost" type="button" onClick={() => remove(item.id)}>
                      delete
                    </button>
                  </li>
                ))}
            </ul>
          </Card>
        ))
      )}
    </Page>
  );
}
