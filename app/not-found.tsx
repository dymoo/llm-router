import Link from "next/link";
import { StatusScreen } from "@/components/admin/StatusScreen";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <StatusScreen
      mood="sad"
      title="Page not found"
      detail="That address isn’t part of the key console."
      action={
        <Link className={buttonVariants({ size: "lg" })} href="/">
          Open Keys
        </Link>
      }
    />
  );
}
