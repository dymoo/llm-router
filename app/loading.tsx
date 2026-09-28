import { COMPANION_NAME } from "@/components/admin/Companion";
import { StatusScreen } from "@/components/admin/StatusScreen";

export default function Loading() {
  return <StatusScreen mood="sleepy" title={`${COMPANION_NAME} is fetching your keys…`} busy />;
}
