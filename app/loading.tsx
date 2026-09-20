export default function Loading() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <header className="chrome">
        <h1>Keys</h1>
      </header>
      <main className="main">
        <div className="skeleton">
          <div className="skel title" />
          <div className="skel line" />
          <div className="skel line" />
          <div className="skel line" />
        </div>
      </main>
    </div>
  );
}
