import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import Bookmarks from './pages/Bookmarks.jsx';
import Environments from './pages/Environments.jsx';
import Music from './pages/Music.jsx';
import Notes from './pages/Notes.jsx';
import Overview from './pages/Overview.jsx';
import Snippets from './pages/Snippets.jsx';
import Tasks from './pages/Tasks.jsx';
import Translate from './pages/Translate.jsx';
import Translation from './pages/Translation.jsx';
import Tools from './pages/Tools.jsx';

const NAV = [
  { to: '/overview', label: 'Overview', icon: '◈' },
  { to: '/tasks', label: 'Tasks', icon: '✓' },
  { to: '/notes', label: 'Notes', icon: '✎' },
  { to: '/snippets', label: 'Snippets', icon: '{}' },
  { to: '/bookmarks', label: 'Bookmarks', icon: '★' },
  { to: '/environments', label: 'Environments', icon: '⛁' },
  { to: '/music', label: 'Music', icon: '♫' },
  { to: '/translate', label: 'Translate', icon: '⇥' },
  { to: '/translation', label: 'Translation Audit', icon: '⇄' },
  { to: '/tools', label: 'Dev Tools', icon: '⚙' }
];

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">DA</span>
          <div>
            <strong>Dev Assistant</strong>
            <small>personal dashboard</small>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/snippets" element={<Snippets />} />
          <Route path="/bookmarks" element={<Bookmarks />} />
          <Route path="/environments" element={<Environments />} />
          <Route path="/music" element={<Music />} />
          <Route path="/translate" element={<Translate />} />
          <Route path="/translation" element={<Translation />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
    </div>
  );
}
