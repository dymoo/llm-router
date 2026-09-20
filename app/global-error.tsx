"use client";

import "./globals.css";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body>
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
      </body>
    </html>
  );
}
