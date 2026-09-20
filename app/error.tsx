"use client";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="error-page">
      <h1>The console could not be shown</h1>
      <p>
        {error.digest
          ? `Reference ${error.digest}. Reload the page or try again.`
          : "Reload the page or try again."}
      </p>
      <button className="btn btn-primary" type="button" onClick={() => retry()}>
        Try Again
      </button>
    </main>
  );
}
