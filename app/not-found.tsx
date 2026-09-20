import Link from "next/link";

export default function NotFound() {
  return (
    <main className="error-page">
      <h1>Page not found</h1>
      <p>That address is not part of the key console.</p>
      <Link className="btn btn-primary" href="/">
        Open Keys
      </Link>
    </main>
  );
}
