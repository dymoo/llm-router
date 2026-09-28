"use client";

import { StatusScreen } from "@/components/admin/StatusScreen";
import { Button } from "@/components/ui/button";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <StatusScreen
      mood="sad"
      title="The console couldn’t be shown"
      detail={
        error.digest
          ? `Reference ${error.digest}. Reload the page or try again.`
          : "Reload the page or try again."
      }
      action={
        <Button size="lg" onClick={() => retry()}>
          Try Again
        </Button>
      }
    />
  );
}
