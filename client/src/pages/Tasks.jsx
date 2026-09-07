import { useState } from 'react';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { useCollection } from '../hooks/useCollection.js';

const EMPTY = { title: '', project: '', priority: 'medium', dueDate: '', notes: '' };

export default function Tasks() {
  const { items, error, create, update, remove } = useCollection('tasks');
  const [form, setForm] = useState(EMPTY);
  const [filter, setFilter] = useState('open');

  const submit = async (event) => {
    event.preventDefault();
    if (!form.title.trim()) return;
    await create(form);
    setForm(EMPTY);
  };

  const visible = items.filter((task) =>
    filter === 'all' ? true : filter === 'open' ? !task.done : task.done
  );

  return (
    <Page title="Tasks" subtitle="Track what you are building, fixing and reviewing.">
      <ErrorBanner message={error} />
      <Card title="New task">
        <form className="form-grid" onSubmit={submit}>
          <input
            placeholder="What needs doing?"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <input
            placeholder="Project / repo"
            value={form.project}
            onChange={(event) => setForm({ ...form, project: event.target.value })}
          />
          <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <input
            type="date"
            value={form.dueDate}
            onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
          />
          <button type="submit">Add task</button>
        </form>
      </Card>

      <div className="tabs">
        {['open', 'done', 'all'].map((value) => (
          <button
            key={value}
            className={filter === value ? 'tab active' : 'tab'}
            onClick={() => setFilter(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>

      <Card>
        {visible.length === 0 ? (
          <EmptyState>Nothing here yet.</EmptyState>
        ) : (
          <ul className="list">
            {visible.map((task) => (
              <li key={task.id}>
                <input type="checkbox" checked={Boolean(task.done)} onChange={() => update(task.id, { done: !task.done })} />
                <span className={`pill ${task.priority}`}>{task.priority}</span>
                <span className={task.done ? 'done' : ''}>{task.title}</span>
                {task.project && <span className="tag">{task.project}</span>}
                <span className="muted right">{task.dueDate || ''}</span>
                <button className="ghost" type="button" onClick={() => remove(task.id)}>
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
