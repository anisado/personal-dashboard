import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Card, ErrorBanner, Page } from '../components/Page.jsx';

const GREETINGS = ['Good morning', 'Good afternoon', 'Good evening'];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return GREETINGS[0];
  if (hour < 18) return GREETINGS[1];
  return GREETINGS[2];
}

export default function Overview() {
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.get('/stats'), api.get('/health'), api.get('/tasks')])
      .then(([statsData, healthData, taskData]) => {
        setStats(statsData);
        setHealth(healthData);
        setTasks(taskData);
      })
      .catch((err) => setError(err.message));
  }, []);

  const upcoming = tasks
    .filter((task) => !task.done)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
    .slice(0, 5);

  return (
    <Page title={`${greeting()}, developer`} subtitle="Everything you are tracking, in one place.">
      <ErrorBanner message={error} />
      <div className="grid stats-grid">
        <Card title="Open tasks">
          <p className="metric">{stats ? stats.tasks.total - stats.tasks.done : '—'}</p>
          <p className="muted">{stats ? `${stats.tasks.done} done · ${stats.tasks.overdue} overdue` : 'loading'}</p>
        </Card>
        <Card title="Notes">
          <p className="metric">{stats?.notes ?? '—'}</p>
          <p className="muted">knowledge captured</p>
        </Card>
        <Card title="Snippets">
          <p className="metric">{stats?.snippets ?? '—'}</p>
          <p className="muted">reusable code</p>
        </Card>
        <Card title="Bookmarks">
          <p className="metric">{stats?.bookmarks ?? '—'}</p>
          <p className="muted">saved links</p>
        </Card>
      </div>

      <div className="grid two-col">
        <Card title="Next up">
          {upcoming.length === 0 ? (
            <p className="muted">
              No open tasks. <Link to="/tasks">Add one</Link>.
            </p>
          ) : (
            <ul className="list">
              {upcoming.map((task) => (
                <li key={task.id}>
                  <span className={`pill ${task.priority}`}>{task.priority}</span>
                  <span>{task.title}</span>
                  <span className="muted right">{task.dueDate || 'no due date'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="API status">
          <ul className="list">
            <li>
              <span>Status</span>
              <span className="right">{health?.status ?? 'unknown'}</span>
            </li>
            <li>
              <span>Uptime</span>
              <span className="right">{health ? `${health.uptimeSeconds}s` : '—'}</span>
            </li>
            <li>
              <span>Server time</span>
              <span className="right">{health ? new Date(health.now).toLocaleString() : '—'}</span>
            </li>
          </ul>
          <p className="muted">
            Jump into <Link to="/tools">Dev Tools</Link> for JSON, JWT, hashing, cron and HTTP utilities.
          </p>
        </Card>
      </div>
    </Page>
  );
}
