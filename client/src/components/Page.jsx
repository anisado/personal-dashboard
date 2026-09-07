export function Page({ title, subtitle, actions, children }) {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, children, className = '' }) {
  return (
    <div className={`card ${className}`.trim()}>
      {title && <h2 className="card-title">{title}</h2>}
      {children}
    </div>
  );
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return <div className="error-banner">{message}</div>;
}

export function EmptyState({ children }) {
  return <p className="muted empty">{children}</p>;
}
